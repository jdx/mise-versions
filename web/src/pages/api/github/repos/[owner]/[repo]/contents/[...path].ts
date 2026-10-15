import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../../../lib/api";
import {
  CONTENTS_BROWSER_TTL_SECONDS,
  CONTENTS_EDGE_TTL_SECONDS,
  getCachedGitHubDirectory,
  normalizeContentsPath,
  validCommitSha,
} from "../../../../../../../lib/github/contents";
import {
  cacheHeaders,
  isGitHubRateLimited,
  matchGitHubMirrorEdgeCache,
  putGitHubMirrorEdgeCache,
  validRepoPart,
} from "../../../../../../../lib/github/mirror";
import { checkGitHubMirrorAccess } from "../../../../../../../lib/github/visibility";

// GET /api/github/repos/{owner}/{repo}/contents/{path}?ref={commit sha}
// The directory {path} ("" for the root) at a full 40-character commit SHA,
// as [{ name, path, type, size, sha }] with type file, dir, symlink or
// submodule. A path that is a file or symlink is a 400; a missing commit or
// path is a 404. A listing at a commit never changes, so the edge keeps it for
// a year. Browsers keep it an hour, as long as the visibility check, so a
// repo that turns private stops being served within the hour.
export const GET: APIRoute = async ({ params, request, locals }) => {
  const { owner, repo } = params;
  const path = normalizeContentsPath(params.path);
  if (!validRepoPart(owner) || !validRepoPart(repo) || path === null) {
    return errorResponse("Invalid GitHub contents path", 400);
  }
  const ref = new URL(request.url).searchParams.get("ref");
  if (!validCommitSha(ref)) {
    return errorResponse("ref must be a full 40-character commit SHA", 400);
  }
  const sha = ref.toLowerCase();

  // Before any cache read: cached responses must not outlive a repo turning
  // private or the mirror being restricted.
  const denied = await checkGitHubMirrorAccess(env, owner, repo, {
    clientKey: request.headers.get("cf-connecting-ip") ?? undefined,
  });
  if (denied) return denied;

  const cacheKeyParams = { ref: sha };
  const cached = await matchGitHubMirrorEdgeCache(
    request,
    undefined,
    cacheKeyParams,
  );
  if (cached) return cached;

  try {
    const listing = await getCachedGitHubDirectory(env, owner, repo, sha, path);
    if ("status" in listing) {
      return listing.status === 404
        ? errorResponse("Not found", 404)
        : errorResponse("Not a directory", 400);
    }
    const response = jsonResponse(
      listing.entries,
      200,
      cacheHeaders({
        browserMaxAge: CONTENTS_BROWSER_TTL_SECONDS,
        edgeMaxAge: CONTENTS_EDGE_TTL_SECONDS,
        immutable: true,
      }),
    );
    locals.cfContext.waitUntil(
      putGitHubMirrorEdgeCache(request, response, {
        browserMaxAge: CONTENTS_BROWSER_TTL_SECONDS,
        edgeMaxAge: CONTENTS_EDGE_TTL_SECONDS,
        staleWhileRevalidate: 0,
        cacheKeyParams,
      }),
    );
    return response;
  } catch (error) {
    console.error(
      `GitHub contents mirror failed for ${owner}/${repo}@${sha}:${path}:`,
      error,
    );
    if (isGitHubRateLimited(error)) {
      return errorResponse("GitHub rate limit reached; try again later", 503);
    }
    return errorResponse("Failed to fetch GitHub contents", 502);
  }
};
