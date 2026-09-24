import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../../../lib/api";
import {
  cacheHeaders,
  getCachedGitHubReleaseResult,
  githubStatus,
  matchGitHubMirrorEdgeCache,
  putGitHubMirrorEdgeCache,
  releaseCacheHeaders,
  releaseEdgeCacheOptions,
  validReleaseTag,
  validRepoPart,
} from "../../../../../../../lib/github/mirror";
import { checkGitHubMirrorAccess } from "../../../../../../../lib/github/visibility";
import { getGitHubLatestReleaseGenerations } from "../../../../../../../lib/github/release-generation";

export const GET: APIRoute = async ({ params, request, locals }) => {
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

  // Before any cache read: cached responses must not outlive a repo turning
  // private or the mirror being restricted.
  const denied = await checkGitHubMirrorAccess(env, owner, repo, {
    clientKey: request.headers.get("cf-connecting-ip") ?? undefined,
  });
  if (denied) return denied;

  const cacheGenerations =
    tag === "latest"
      ? await getGitHubLatestReleaseGenerations(env.GITHUB_CACHE, owner, repo)
      : undefined;
  const cacheGeneration = cacheGenerations?.current;
  const cached = await matchGitHubMirrorEdgeCache(request, cacheGeneration);
  if (cached) return cached;

  try {
    const { release, staleFallback } = await getCachedGitHubReleaseResult(
      env,
      owner,
      repo,
      tag,
      cacheGeneration,
      cacheGenerations?.previous,
    );
    const response = jsonResponse(
      release,
      200,
      staleFallback
        ? cacheHeaders({
            browserMaxAge: 0,
            edgeMaxAge: 0,
            staleWhileRevalidate: 0,
          })
        : releaseCacheHeaders(tag, release, cacheGeneration),
    );
    if (!staleFallback) {
      locals.cfContext.waitUntil(
        putGitHubMirrorEdgeCache(
          request,
          response,
          releaseEdgeCacheOptions(tag, release, cacheGeneration),
        ),
      );
    }
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
