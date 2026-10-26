import { GitHubError, githubPoolJson, githubStatus } from "./mirror";

// A packslip project's signed release list lives on its repository's default
// branch, at `.well-known/packslip.json` or, for a project in a subdirectory,
// `.well-known/packslip/<sub>.json`. Almost no repository has one, so what a
// client most needs to hear is that there is none. The answer is kept at the
// edge only, for ten minutes, the same as a release list's first page: a
// vendor who publishes a list, or withdraws a version in it, reaches clients
// within that.
export const PACKSLIP_LIST_EDGE_TTL_SECONDS = 10 * 60;
// GitHub's contents API does not return the body of a file over 1 MB.
const MAX_LIST_BYTES = 1024 * 1024;
const MAX_SUB_LENGTH = 512;

/** What the endpoint answers: the list's exact text, or that there is none. */
export type PackslipListAnswer =
  | { present: true; text: string; fetched_at: string }
  | { present: false; fetched_at: string };

interface GitHubContentsFile {
  type?: string;
  encoding?: string;
  content?: string;
  size?: number;
}

/**
 * The repository path of a project's list. `sub` is the project's path inside
 * its repository ("" for a repository's own project), or null when it is not a
 * plain relative path.
 */
export function packslipListPath(sub: string): string | null {
  if (sub === "") return ".well-known/packslip.json";
  if (sub.length > MAX_SUB_LENGTH) return null;
  const valid = sub
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9._+@~-]+$/.test(segment),
    );
  return valid ? `.well-known/packslip/${sub}.json` : null;
}

/**
 * Read a project's list from the repository's default branch with a pool
 * token. A missing file, a directory, a symlink or a submodule at the path is
 * "no list", as it is to a client reading raw.githubusercontent.com, which
 * answers 404 for each. Anything else GitHub says, or a file the contents API
 * will not return whole, is thrown, so the caller never mistakes an outage
 * for an absent list.
 */
export async function fetchPackslipList(
  env: Parameters<typeof githubPoolJson>[0],
  owner: string,
  repo: string,
  sub: string,
): Promise<PackslipListAnswer> {
  const path = packslipListPath(sub);
  if (path === null) {
    throw new GitHubError(400, "Invalid packslip project path", new Headers());
  }
  const fetched_at = new Date().toISOString();
  let file: GitHubContentsFile | GitHubContentsFile[];
  try {
    file = await githubPoolJson<GitHubContentsFile | GitHubContentsFile[]>(
      env,
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
    );
  } catch (error) {
    if (githubStatus(error) === 404) return { present: false, fetched_at };
    throw error;
  }
  if (Array.isArray(file) || file.type !== "file") {
    return { present: false, fetched_at };
  }
  if (file.encoding !== "base64" || typeof file.content !== "string") {
    throw new GitHubError(
      502,
      "GitHub did not return the packslip list's contents",
      new Headers(),
    );
  }
  const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, "")), (c) =>
    c.charCodeAt(0),
  );
  if (bytes.length > MAX_LIST_BYTES) {
    throw new GitHubError(502, "The packslip list is too large", new Headers());
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubError(502, "The packslip list is not UTF-8", new Headers());
  }
  return { present: true, text, fetched_at };
}
