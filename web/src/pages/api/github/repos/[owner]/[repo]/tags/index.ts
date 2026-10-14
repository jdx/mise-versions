import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../../../lib/api";
import {
  cacheHeaders,
  getCachedGitHubTagList,
  githubStatus,
  isGitHubRateLimited,
  matchGitHubMirrorEdgeCache,
  NoGraphQLTokenError,
  putGitHubMirrorEdgeCache,
  TAG_LIST_MAX_PAGE,
  validRepoPart,
} from "../../../../../../../lib/github/mirror";
import { checkGitHubMirrorAccess } from "../../../../../../../lib/github/visibility";

// GET /api/github/repos/{owner}/{repo}/tags?page=N[&dates=1]
// One page of GitHub's tag list (per_page=100), in GitHub's order, as
// { tags: [{ name, commit: { sha, url }, date? }], next_page, truncated }.
// With dates=1, each tag also has its commit's committer date.
export const GET: APIRoute = async ({ params, request, locals }) => {
  const { owner, repo } = params;
  if (!validRepoPart(owner) || !validRepoPart(repo)) {
    return errorResponse("Invalid GitHub tag list path", 400);
  }
  const searchParams = new URL(request.url).searchParams;
  const pageParam = searchParams.get("page") ?? "1";
  const page = /^[0-9]{1,2}$/.test(pageParam) ? Number(pageParam) : NaN;
  if (!(page >= 1 && page <= TAG_LIST_MAX_PAGE)) {
    return errorResponse(
      `page must be between 1 and ${TAG_LIST_MAX_PAGE}`,
      400,
    );
  }
  const datesParam = searchParams.get("dates") ?? "0";
  if (!["0", "1", "false", "true"].includes(datesParam)) {
    return errorResponse("dates must be 1 or 0", 400);
  }
  const dates = datesParam === "1" || datesParam === "true";

  // Before any cache read: cached responses must not outlive a repo turning
  // private or the mirror being restricted.
  const denied = await checkGitHubMirrorAccess(env, owner, repo, {
    clientKey: request.headers.get("cf-connecting-ip") ?? undefined,
  });
  if (denied) return denied;

  const cacheKeyParams: Record<string, string> = { page: String(page) };
  if (dates) cacheKeyParams.dates = "1";
  const cached = await matchGitHubMirrorEdgeCache(
    request,
    undefined,
    cacheKeyParams,
  );
  if (cached) return cached;

  try {
    const { list, staleFallback, freshSeconds } = await getCachedGitHubTagList(
      env,
      owner,
      repo,
      page,
      { dates },
    );
    // A stale fallback is served once but not edge-cached, so the next
    // request retries GitHub.
    const maxAge = freshSeconds;
    const response = jsonResponse(
      list,
      200,
      cacheHeaders({
        browserMaxAge: 0,
        edgeMaxAge: maxAge,
        staleWhileRevalidate: 0,
      }),
    );
    if (staleFallback) return response;
    locals.cfContext.waitUntil(
      putGitHubMirrorEdgeCache(request, response, {
        browserMaxAge: 0,
        edgeMaxAge: maxAge,
        staleWhileRevalidate: 0,
        cacheKeyParams,
      }),
    );
    return response;
  } catch (error) {
    console.error(
      `GitHub tag list mirror failed for ${owner}/${repo} page ${page}:`,
      error,
    );
    if (githubStatus(error) === 404) return errorResponse("Not found", 404);
    // Temporary: the client should fall back to GitHub and not cache this.
    // Not 403, which mise reads as the mirror being restricted.
    if (error instanceof NoGraphQLTokenError) {
      return errorResponse("GitHub tag dates are unavailable right now", 503);
    }
    if (isGitHubRateLimited(error)) {
      return errorResponse("GitHub rate limit reached; try again later", 503);
    }
    return errorResponse("Failed to fetch GitHub tags", 502);
  }
};
