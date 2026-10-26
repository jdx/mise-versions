import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../../../lib/api";
import {
  cacheHeaders,
  isGitHubRateLimited,
  matchGitHubMirrorEdgeCache,
  putGitHubMirrorEdgeCache,
  validRepoPart,
} from "../../../../../../../lib/github/mirror";
import {
  PACKSLIP_LIST_EDGE_TTL_SECONDS,
  fetchPackslipList,
  packslipListPath,
} from "../../../../../../../lib/github/packslip-list";
import { checkGitHubMirrorAccess } from "../../../../../../../lib/github/visibility";

// GET /api/github/repos/{owner}/{repo}/packslip-list[/{sub}]
// A packslip project's signed release list, from the repository's default
// branch: `.well-known/packslip.json`, or `.well-known/packslip/{sub}.json`
// for a project in a subdirectory. Always a 200 JSON object,
// { present: true, text, fetched_at } with the file's exact text, or
// { present: false, fetched_at } when the repository has no such file, which
// is nearly always. A private or blocked repo is a 404 or 403, as for the
// other mirror routes, and says nothing about the list. The edge keeps the
// answer for ten minutes, so a rate limit on GitHub's side never reaches
// clients that ask often.
export const GET: APIRoute = async ({ params, request, locals }) => {
  const { owner, repo } = params;
  let sub: string;
  try {
    sub =
      typeof params.sub === "string"
        ? decodeURIComponent(params.sub).replace(/^\/+|\/+$/g, "")
        : "";
  } catch {
    return errorResponse("Invalid packslip project path", 400);
  }
  if (
    !validRepoPart(owner) ||
    !validRepoPart(repo) ||
    packslipListPath(sub) === null
  ) {
    return errorResponse("Invalid packslip project path", 400);
  }

  // Before any cache read: cached answers must not outlive a repo turning
  // private or the mirror being restricted.
  const denied = await checkGitHubMirrorAccess(env, owner, repo, {
    clientKey: request.headers.get("cf-connecting-ip") ?? undefined,
  });
  if (denied) return denied;

  // The sub path is part of the URL, so it keys the edge entry; the query is
  // ignored.
  const cached = await matchGitHubMirrorEdgeCache(request);
  if (cached) return cached;

  try {
    const answer = await fetchPackslipList(env, owner, repo, sub);
    const options = {
      browserMaxAge: 0,
      edgeMaxAge: PACKSLIP_LIST_EDGE_TTL_SECONDS,
      staleWhileRevalidate: 0,
    };
    const response = jsonResponse(answer, 200, cacheHeaders(options));
    locals.cfContext.waitUntil(
      putGitHubMirrorEdgeCache(request, response, options),
    );
    return response;
  } catch (error) {
    console.error(
      `GitHub packslip list mirror failed for ${owner}/${repo}/${sub}:`,
      error,
    );
    if (isGitHubRateLimited(error)) {
      return errorResponse("GitHub rate limit reached; try again later", 503);
    }
    return errorResponse("Failed to fetch the packslip list", 502);
  }
};
