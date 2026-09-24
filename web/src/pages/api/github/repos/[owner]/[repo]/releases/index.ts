import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../../../lib/api";
import {
  cacheHeaders,
  getCachedGitHubReleaseList,
  githubStatus,
  matchGitHubMirrorEdgeCache,
  putGitHubMirrorEdgeCache,
  RELEASE_LIST_MAX_PAGE,
  releaseListFreshSeconds,
  validRepoPart,
} from "../../../../../../../lib/github/mirror";
import { getGitHubLatestReleaseGenerations } from "../../../../../../../lib/github/release-generation";
import { checkGitHubMirrorAccess } from "../../../../../../../lib/github/visibility";

// GET /api/github/repos/{owner}/{repo}/releases?page=N
// One page of GitHub's release list (per_page=100), drafts removed, as
// { releases, next_page }.
export const GET: APIRoute = async ({ params, request, locals }) => {
  const { owner, repo } = params;
  if (!validRepoPart(owner) || !validRepoPart(repo)) {
    return errorResponse("Invalid GitHub release list path", 400);
  }
  const pageParam = new URL(request.url).searchParams.get("page") ?? "1";
  const page = /^[0-9]{1,2}$/.test(pageParam) ? Number(pageParam) : NaN;
  if (!(page >= 1 && page <= RELEASE_LIST_MAX_PAGE)) {
    return errorResponse(
      `page must be between 1 and ${RELEASE_LIST_MAX_PAGE}`,
      400,
    );
  }

  // Before any cache read: cached responses must not outlive a repo turning
  // private or the mirror being restricted.
  const denied = await checkGitHubMirrorAccess(env, owner, repo, {
    clientKey: request.headers.get("cf-connecting-ip") ?? undefined,
  });
  if (denied) return denied;

  // The first page changes when a release is published; tie it to the same
  // generation that invalidates the mirrored `latest` release.
  const cacheGeneration =
    page === 1
      ? (await getGitHubLatestReleaseGenerations(env.GITHUB_CACHE, owner, repo))
          ?.current
      : undefined;
  const cacheKeyParams = { page: String(page) };
  const cached = await matchGitHubMirrorEdgeCache(
    request,
    cacheGeneration,
    cacheKeyParams,
  );
  if (cached) return cached;

  try {
    const { list, staleFallback } = await getCachedGitHubReleaseList(
      env,
      owner,
      repo,
      page,
      cacheGeneration,
    );
    // A stale fallback is served once but not edge-cached, so the next
    // request retries GitHub.
    const maxAge = staleFallback ? 0 : releaseListFreshSeconds(page);
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
        cacheGeneration,
        cacheKeyParams,
      }),
    );
    return response;
  } catch (error) {
    console.error(
      `GitHub release list mirror failed for ${owner}/${repo} page ${page}:`,
      error,
    );
    return errorResponse(
      githubStatus(error) === 404
        ? "Not found"
        : "Failed to fetch GitHub releases",
      githubStatus(error) === 404 ? 404 : 502,
    );
  }
};
