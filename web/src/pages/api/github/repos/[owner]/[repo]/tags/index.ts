import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../../../lib/api";
import {
  cacheHeaders,
  getCachedGitHubTagList,
  githubStatus,
  matchGitHubMirrorEdgeCache,
  putGitHubMirrorEdgeCache,
  TAG_LIST_MAX_PAGE,
  tagListFreshSeconds,
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
    const { list, staleFallback } = await getCachedGitHubTagList(
      env,
      owner,
      repo,
      page,
      { dates },
    );
    // A stale fallback is served once but not edge-cached, so the next
    // request retries GitHub.
    const maxAge = staleFallback ? 0 : tagListFreshSeconds(page);
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
    return errorResponse(
      githubStatus(error) === 404 ? "Not found" : "Failed to fetch GitHub tags",
      githubStatus(error) === 404 ? 404 : 502,
    );
  }
};
