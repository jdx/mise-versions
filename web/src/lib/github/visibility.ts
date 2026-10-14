import { errorResponse } from "../api";
import { readThroughMemo } from "./edge-memo";
import { githubPoolJson, githubStatus } from "./mirror";
import {
  isKnownGitHubAttestationRepo,
  isRegisteredGitHubRepo,
} from "./registry";

// Both answers are cached for an hour. Caching "not public" as well keeps
// requests for random or private repos from spending pool quota, and bounds
// how long a repo that turns private can still be served. The KV entry and
// its edge memo (edge-memo.ts) both expire an hour after the GitHub check.
const VISIBILITY_TTL_SECONDS = 60 * 60;

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  DB: D1Database;
  ANALYTICS_DB: D1Database;
  GITHUB_CACHE: KVNamespace;
  GITHUB_MIRROR_ACCESS?: string;
  // Bounds how many uncached lookups one client can make. Negative caching
  // only helps with repeated names; this stops a stream of unique names from
  // spending the token pool.
  GITHUB_VISIBILITY_LIMITER?: RateLimiter;
}

/** A client made too many uncached visibility lookups. */
export class VisibilityLookupLimited extends Error {}

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
  { clientKey }: { clientKey?: string } = {},
): Promise<boolean> {
  const cacheKey = `github:visibility:${owner.toLowerCase()}/${repo.toLowerCase()}`;
  // Every mirror request asks this before anything else, so serve it from
  // the free memo tier when possible. A memoized answer expires when the KV
  // answer it copies would, so a repo that turns private is still cut off
  // within VISIBILITY_TTL_SECONDS of the last check, as without the memo.
  return readThroughMemo(env.GITHUB_CACHE, cacheKey, async () => {
    const entry = await lookUpVisibility(env, cacheKey, owner, repo, clientKey);
    return {
      value: entry.public,
      expiresAt:
        Math.min(entry.cached_at, Date.now()) + VISIBILITY_TTL_SECONDS * 1000,
    };
  });
}

async function lookUpVisibility(
  env: Env,
  cacheKey: string,
  owner: string,
  repo: string,
  clientKey: string | undefined,
): Promise<CachedVisibility> {
  const cached = await env.GITHUB_CACHE.get<CachedVisibility>(cacheKey, "json");
  if (
    cached &&
    typeof cached.public === "boolean" &&
    typeof cached.cached_at === "number" &&
    Date.now() - cached.cached_at < VISIBILITY_TTL_SECONDS * 1000
  ) {
    return cached;
  }

  if (
    env.GITHUB_VISIBILITY_LIMITER &&
    !(
      await env.GITHUB_VISIBILITY_LIMITER.limit({
        key: clientKey ?? "unknown",
      })
    ).success
  ) {
    throw new VisibilityLookupLimited();
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
  try {
    await env.GITHUB_CACHE.put(cacheKey, JSON.stringify(entry), {
      expirationTtl: VISIBILITY_TTL_SECONDS,
    });
  } catch (error) {
    // The answer stands; once the memo expires the next request asks GitHub
    // again.
    console.warn(
      `failed to cache GitHub visibility for ${owner}/${repo}:`,
      error,
    );
  }
  return entry;
}

/**
 * Decide whether the mirror may serve this repository. Returns the error
 * response to send, or null to proceed. Call it before reading any cache.
 *
 * A private or missing repo gets a 404, like GitHub, so its existence is not
 * revealed and mise clients fall back quietly. A mirror that has been
 * restricted or disabled answers 403, which mise clients report as a
 * warning. `clientKey` identifies the caller for the lookup rate limit.
 */
export async function checkGitHubMirrorAccess(
  env: Env,
  owner: string,
  repo: string,
  {
    attestations = false,
    clientKey,
  }: { attestations?: boolean; clientKey?: string } = {},
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
    isPublic = await isPublicGitHubRepo(env, owner, repo, { clientKey });
  } catch (error) {
    if (error instanceof VisibilityLookupLimited) {
      return errorResponse("Too many uncached repository lookups", 429);
    }
    console.error(
      `GitHub visibility check failed for ${owner}/${repo}:`,
      error,
    );
    return errorResponse("Failed to check GitHub repo visibility", 503);
  }
  return isPublic ? null : errorResponse("Not found", 404);
}
