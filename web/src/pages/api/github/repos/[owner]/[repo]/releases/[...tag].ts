import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../../../lib/api";
import {
  getCachedGitHubRelease,
  githubStatus,
  matchGitHubMirrorEdgeCache,
  putGitHubMirrorEdgeCache,
  releaseCacheHeaders,
  validReleaseTag,
  validRepoPart,
} from "../../../../../../../lib/github/mirror";
import { isRegisteredGitHubRepo } from "../../../../../../../lib/github/registry";

export const GET: APIRoute = async ({ params, request }) => {
  const { owner, repo } = params;
  // Cloudflare/Astro preserves percent-encoded characters (notably %2F) in
  // catch-all path params rather than decoding them, so tags such as
  // `@biomejs/biome@2.5.0` arrive here as `%40biomejs%2Fbiome%402.5.0` and would
  // otherwise be rejected by `validReleaseTag`.
  let tag: string | undefined;
  try {
    tag =
      typeof params.tag === "string"
        ? decodeURIComponent(params.tag)
        : undefined;
  } catch {
    return errorResponse("Invalid GitHub release path", 400);
  }
  if (!validRepoPart(owner) || !validRepoPart(repo) || !validReleaseTag(tag)) {
    return errorResponse("Invalid GitHub release path", 400);
  }

  const cached = await matchGitHubMirrorEdgeCache(request);
  if (cached) return cached;

  let registered: boolean;
  try {
    registered = await isRegisteredGitHubRepo(env.ANALYTICS_DB, owner, repo);
  } catch (error) {
    console.error(`GitHub registry check failed for ${owner}/${repo}:`, error);
    return errorResponse("Failed to check GitHub repo registry", 503);
  }
  if (!registered) {
    return errorResponse("GitHub repo is not in the mise registry", 403);
  }

  try {
    const release = await getCachedGitHubRelease(env, owner, repo, tag);
    const response = jsonResponse(
      release,
      200,
      releaseCacheHeaders(tag, release),
    );
    await putGitHubMirrorEdgeCache(request, response);
    return response;
  } catch (error) {
    console.error(
      `GitHub release mirror failed for ${owner}/${repo}@${tag}:`,
      error,
    );
    return errorResponse(
      githubStatus(error) === 404
        ? "Not found"
        : "Failed to fetch GitHub release",
      githubStatus(error) === 404 ? 404 : 502,
    );
  }
};
