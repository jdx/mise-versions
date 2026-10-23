import { GitHubError, githubPoolJson, githubStatus } from "./mirror";

// A listing at a full commit SHA never changes, so it is kept for as long as
// KV allows. "Not a directory" never changes either. "Not found" is kept
// briefly: a commit that has not been pushed yet can still appear.
const LISTING_TTL_SECONDS = 30 * 24 * 60 * 60;
const NOT_FOUND_TTL_SECONDS = 30 * 60;
export const CONTENTS_EDGE_TTL_SECONDS = 365 * 24 * 60 * 60;
export const CONTENTS_BROWSER_TTL_SECONDS = 60 * 60;
const MAX_PATH_LENGTH = 4096;
// KV keys are at most 512 bytes; longer ones use a hash of the path.
const MAX_KEY_LENGTH = 480;

interface Env {
  DB: D1Database;
  GITHUB_CACHE: KVNamespace;
}

export type GitHubContentsType = "file" | "dir" | "symlink" | "submodule";

/** One entry of a directory, as GitHub's contents API lists it. */
export interface GitHubContentsEntry {
  name: string;
  path: string;
  type: GitHubContentsType;
  size: number;
  sha: string;
}

/** A directory's entries, or why there is none. */
export type GitHubDirectoryListing =
  | { entries: GitHubContentsEntry[] }
  | { status: 400 | 404 };

interface CachedListing {
  cached_at: number;
  data: GitHubDirectoryListing;
}

interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

interface GitHubTree {
  tree?: GitHubTreeEntry[];
  truncated?: boolean;
}

export function validCommitSha(value: string | null): value is string {
  return !!value && /^[0-9a-fA-F]{40}$/.test(value);
}

/**
 * The repository path a request names, without leading or trailing slashes
 * ("" for the root), or null when it is not a plain path.
 */
export function normalizeContentsPath(
  value: string | undefined,
): string | null {
  const path = (value ?? "").replace(/^\/+|\/+$/g, "");
  if (path === "") return "";
  if (path.length > MAX_PATH_LENGTH) return null;
  const segments = path.split("/");
  const valid = segments.every(
    (segment) =>
      segment !== "" &&
      segment !== "." &&
      segment !== ".." &&
      // No control characters (git allows them, but nobody vendors them).
      !/[\u0000-\u001f\u007f]/.test(segment),
  );
  return valid ? path : null;
}

/**
 * List the directory `path` of a repository at commit `sha`.
 *
 * Built from the git trees API (`git/trees/{sha}:{path}`) rather than the
 * contents API: a contents directory listing reports symlinks and
 * submodules as "file", and stops at 1,000 entries. A tree gives each
 * entry's git mode, so symlinks (120000) and submodules (160000) keep their
 * own type, and holds up to 100,000 entries.
 */
export async function getCachedGitHubDirectory(
  env: Env,
  owner: string,
  repo: string,
  sha: string,
  path: string,
): Promise<GitHubDirectoryListing> {
  const commit = sha.toLowerCase();
  const cacheKey = await contentsCacheKey(owner, repo, commit, path);
  const cached = await env.GITHUB_CACHE.get<CachedListing>(cacheKey, "json");
  if (cached) return cached.data;

  const data = await fetchGitHubDirectory(env, owner, repo, commit, path);
  const entry: CachedListing = { cached_at: Date.now(), data };
  try {
    await env.GITHUB_CACHE.put(cacheKey, JSON.stringify(entry), {
      expirationTtl:
        "status" in data && data.status === 404
          ? NOT_FOUND_TTL_SECONDS
          : LISTING_TTL_SECONDS,
    });
  } catch (error) {
    console.warn(`failed to cache ${cacheKey}:`, error);
  }
  return data;
}

async function fetchGitHubDirectory(
  env: Env,
  owner: string,
  repo: string,
  sha: string,
  path: string,
): Promise<GitHubDirectoryListing> {
  // `{sha}:{path}` is git's tree-ish for a directory at a commit; the bare
  // SHA is the commit's root tree.
  const treeish = path
    ? `${sha}:${path.split("/").map(encodeURIComponent).join("/")}`
    : sha;
  let tree: GitHubTree;
  try {
    tree = await githubPoolJson<GitHubTree>(
      env,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${treeish}`,
    );
  } catch (error) {
    // 404: no such commit, or no such path at it (a submodule's directory
    // is not in this repository either). 422: the path is a file or a
    // symlink.
    if (githubStatus(error) === 404) return { status: 404 };
    if (githubStatus(error) === 422) return { status: 400 };
    throw error;
  }
  if (!Array.isArray(tree.tree)) {
    throw new GitHubError(
      502,
      "GitHub tree response did not include entries",
      new Headers(),
    );
  }
  if (tree.truncated) {
    throw new GitHubError(
      502,
      "GitHub truncated the directory listing",
      new Headers(),
    );
  }
  return {
    entries: tree.tree.map((entry) => ({
      name: entry.path,
      path: path ? `${path}/${entry.path}` : entry.path,
      type: contentsType(entry),
      size: entry.type === "blob" ? (entry.size ?? 0) : 0,
      sha: entry.sha,
    })),
  };
}

function contentsType(entry: GitHubTreeEntry): GitHubContentsType {
  if (entry.mode === "120000") return "symlink";
  if (entry.mode === "160000" || entry.type === "commit") return "submodule";
  if (entry.type === "tree") return "dir";
  return "file";
}

async function contentsCacheKey(
  owner: string,
  repo: string,
  sha: string,
  path: string,
): Promise<string> {
  const repository = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const key = `github:contents:${repository}:${sha}:${path}`;
  if (new TextEncoder().encode(key).length <= MAX_KEY_LENGTH) return key;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(path),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `github:contents-hash:${repository}:${sha}:${hex}`;
}
