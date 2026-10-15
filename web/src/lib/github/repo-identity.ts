import { GitHubError, githubPoolJson } from "./mirror";

// A rename or transfer shows up within this long. Repo ids never change.
export const REPO_IDENTITY_TTL_SECONDS = 6 * 60 * 60;
// Browsers keep it as long as the visibility check, so a repo that turns
// private stops being served within the hour.
export const REPO_IDENTITY_BROWSER_TTL_SECONDS = 60 * 60;

interface Env {
  DB: D1Database;
  GITHUB_CACHE: KVNamespace;
}

/** Who a repository is now: its id, current name, and owner's id. */
export interface GitHubRepoIdentity {
  id: number;
  full_name: string;
  owner: { id: number };
}

interface CachedIdentity {
  cached_at: number;
  data: GitHubRepoIdentity;
}

interface GitHubRepo {
  id?: unknown;
  full_name?: unknown;
  owner?: { id?: unknown };
  private?: unknown;
  visibility?: unknown;
}

/**
 * The repository GitHub serves for `owner/repo`, following a rename or
 * transfer redirect to its current name. Only public repositories have one:
 * anything else is a 404, as in the visibility check.
 */
export async function getCachedGitHubRepoIdentity(
  env: Env,
  owner: string,
  repo: string,
): Promise<GitHubRepoIdentity> {
  const cacheKey = `github:repo-identity:${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const cached = await env.GITHUB_CACHE.get<CachedIdentity>(cacheKey, "json");
  if (
    cached &&
    Date.now() - cached.cached_at < REPO_IDENTITY_TTL_SECONDS * 1000
  ) {
    return cached.data;
  }

  // The pool follows GitHub's redirect for a renamed repo
  // (/repositories/{id}), so this answers with the current name.
  const data = await githubPoolJson<GitHubRepo>(
    env,
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  );
  if (data.private !== false || data.visibility !== "public") {
    throw new GitHubError(404, "Not found", new Headers());
  }
  if (
    typeof data.id !== "number" ||
    typeof data.full_name !== "string" ||
    typeof data.owner?.id !== "number"
  ) {
    throw new GitHubError(
      502,
      "GitHub repository response did not include its identity",
      new Headers(),
    );
  }
  const identity: GitHubRepoIdentity = {
    id: data.id,
    full_name: data.full_name,
    owner: { id: data.owner.id },
  };
  const entry: CachedIdentity = { cached_at: Date.now(), data: identity };
  try {
    await env.GITHUB_CACHE.put(cacheKey, JSON.stringify(entry), {
      expirationTtl: REPO_IDENTITY_TTL_SECONDS,
    });
  } catch (error) {
    console.warn(`failed to cache ${cacheKey}:`, error);
  }
  return identity;
}
