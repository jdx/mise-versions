import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../../lib/api";
import {
  cacheHeaders,
  githubStatus,
  isGitHubRateLimited,
  matchGitHubMirrorEdgeCache,
  putGitHubMirrorEdgeCache,
  validRepoPart,
} from "../../../../../../lib/github/mirror";
import {
  getCachedGitHubRepoIdentity,
  REPO_IDENTITY_BROWSER_TTL_SECONDS,
  REPO_IDENTITY_TTL_SECONDS,
} from "../../../../../../lib/github/repo-identity";
import { checkGitHubMirrorAccess } from "../../../../../../lib/github/visibility";

// GET /api/github/repos/{owner}/{repo}
// Who a public repository is now, following GitHub's redirect for a renamed
// or transferred repo: { id, full_name, owner: { id } }. A private or
// missing repo is a 404.
export const GET: APIRoute = async ({ params, request, locals }) => {
  const { owner, repo } = params;
  if (!validRepoPart(owner) || !validRepoPart(repo)) {
    return errorResponse("Invalid GitHub repository path", 400);
  }

  // Before any cache read: cached responses must not outlive a repo turning
  // private or the mirror being restricted.
  const denied = await checkGitHubMirrorAccess(env, owner, repo, {
    clientKey: request.headers.get("cf-connecting-ip") ?? undefined,
  });
  if (denied) return denied;

  const cached = await matchGitHubMirrorEdgeCache(request);
  if (cached) return cached;

  try {
    const identity = await getCachedGitHubRepoIdentity(env, owner, repo);
    const response = jsonResponse(
      identity,
      200,
      cacheHeaders({
        browserMaxAge: REPO_IDENTITY_BROWSER_TTL_SECONDS,
        edgeMaxAge: REPO_IDENTITY_TTL_SECONDS,
        staleWhileRevalidate: 0,
      }),
    );
    locals.cfContext.waitUntil(
      putGitHubMirrorEdgeCache(request, response, {
        browserMaxAge: REPO_IDENTITY_BROWSER_TTL_SECONDS,
        edgeMaxAge: REPO_IDENTITY_TTL_SECONDS,
        staleWhileRevalidate: 0,
      }),
    );
    return response;
  } catch (error) {
    console.error(
      `GitHub repository mirror failed for ${owner}/${repo}:`,
      error,
    );
    const status = githubStatus(error);
    if (status === 404 || status === 451)
      return errorResponse("Not found", 404);
    if (isGitHubRateLimited(error)) {
      return errorResponse("GitHub rate limit reached; try again later", 503);
    }
    return errorResponse("Failed to fetch GitHub repository", 502);
  }
};
