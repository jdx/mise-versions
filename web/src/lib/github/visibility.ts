import { errorResponse } from "../api";
import { githubPoolJson, githubStatus } from "./mirror";
import {
  isKnownGitHubAttestationRepo,
  isRegisteredGitHubRepo,
} from "./registry";

// Both answers are cached for an hour. Caching "not public" as well keeps
// requests for random or private repos from spending pool quota, and bounds
// how long a repo that turns private can still be served.
const VISIBILITY_TTL_SECONDS = 60 * 60;

interface Env {
  DB: D1Database;
  ANALYTICS_DB: D1Database;
  GITHUB_CACHE: KVNamespace;
  GITHUB_MIRROR_ACCESS?: string;
}

interface GitHubRepoVisibility {
  private?: unknown;
  visibility?: unknown;
}

interface CachedVisibility {
  cached_at: number;
  public: boolean;
}

export type GitHubMirrorAccess = "public" | "registry" | "off";

export function gitHubMirrorAccess(
  value: string | undefined,
): GitHubMirrorAccess {
  return value === "registry" || value === "off" ? value : "public";
}

/**
 * Whether GitHub reports the repository as public. The pool's tokens may be
 * able to read private repositories, so the mirror must ask rather than rely
 * on a fetch failing. Anything other than an explicit public answer is
 * treated as private.
 */
export async function isPublicGitHubRepo(
  env: Env,
  owner: string,
  repo: string,
): Promise<boolean> {
  const cacheKey = `github:visibility:${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const cached = await env.GITHUB_CACHE.get<CachedVisibility>(cacheKey, "json");
  if (
    cached &&
    typeof cached.public === "boolean" &&
    Date.now() - cached.cached_at < VISIBILITY_TTL_SECONDS * 1000
  ) {
    return cached.public;
  }

  let isPublic: boolean;
  try {
    const data = await githubPoolJson<GitHubRepoVisibility>(
      env,
      `https://api.github.com/repos/${owner}/${repo}`,
    );
    isPublic = data.private === false && data.visibility === "public";
  } catch (error) {
    const status = githubStatus(error);
    // Missing, or blocked for legal reasons: definitively not servable.
    // Anything else (rate limits, 5xx, network) is not an answer.
    if (status !== 404 && status !== 451) {
      throw error;
    }
    isPublic = false;
  }

  const entry: CachedVisibility = { cached_at: Date.now(), public: isPublic };
  await env.GITHUB_CACHE.put(cacheKey, JSON.stringify(entry), {
    expirationTtl: VISIBILITY_TTL_SECONDS,
  });
  return isPublic;
}

/**
 * Decide whether the mirror may serve this repository. Returns the error
 * response to send, or null to proceed. Call it before reading any cache.
 *
 * A private or missing repo gets a 404, like GitHub, so its existence is not
 * revealed and mise clients fall back quietly. A mirror that has been
 * restricted or disabled answers 403, which mise clients report as a
 * warning.
 */
export async function checkGitHubMirrorAccess(
  env: Env,
  owner: string,
  repo: string,
  { attestations = false }: { attestations?: boolean } = {},
): Promise<Response | null> {
  const access = gitHubMirrorAccess(env.GITHUB_MIRROR_ACCESS);
  if (access === "off") {
    return errorResponse("GitHub mirror is disabled", 403);
  }

  if (access === "registry") {
    let registered: boolean;
    try {
      registered =
        (attestations && isKnownGitHubAttestationRepo(owner, repo)) ||
        (await isRegisteredGitHubRepo(env.ANALYTICS_DB, owner, repo));
    } catch (error) {
      console.error(
        `GitHub registry check failed for ${owner}/${repo}:`,
        error,
      );
      return errorResponse("Failed to check GitHub repo registry", 503);
    }
    if (!registered) {
      return errorResponse("GitHub repo is not in the mise registry", 403);
    }
  }

  let isPublic: boolean;
  try {
    isPublic = await isPublicGitHubRepo(env, owner, repo);
  } catch (error) {
    console.error(
      `GitHub visibility check failed for ${owner}/${repo}:`,
      error,
    );
    return errorResponse("Failed to check GitHub repo visibility", 503);
  }
  return isPublic ? null : errorResponse("Not found", 404);
}
