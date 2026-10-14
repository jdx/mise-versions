import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../../../lib/api";
import {
  cacheHeaders,
  githubStatus,
  matchGitHubMirrorEdgeCache,
  putGitHubMirrorEdgeCache,
  validRepoPart,
} from "../../../../../../../lib/github/mirror";
import { getGitHubLatestReleaseGenerations } from "../../../../../../../lib/github/release-generation";
import {
  getCachedGitHubVersions,
  validAssetName,
  VersionsCrawlLimited,
  type VersionsSource,
} from "../../../../../../../lib/github/versions";
import { checkGitHubMirrorAccess } from "../../../../../../../lib/github/visibility";

// GET /api/github/repos/{owner}/{repo}/versions?source=releases|tags[&asset=NAME]
// The repository's whole release or tag list, compacted. The client contract
// is docs/github-versions.md.
export const GET: APIRoute = async ({ params, request, locals }) => {
  const { owner, repo } = params;
  if (!validRepoPart(owner) || !validRepoPart(repo)) {
    return errorResponse("Invalid GitHub versions path", 400);
  }
  const searchParams = new URL(request.url).searchParams;
  const sourceParam = searchParams.get("source") ?? "releases";
  if (sourceParam !== "releases" && sourceParam !== "tags") {
    return errorResponse("source must be releases or tags", 400);
  }
  const source: VersionsSource = sourceParam;
  const assetParam = searchParams.get("asset") ?? undefined;
  if (assetParam !== undefined) {
    if (source !== "releases") {
      return errorResponse("asset only applies to source=releases", 400);
    }
    if (!validAssetName(assetParam)) {
      return errorResponse("Invalid asset name", 400);
    }
  }
  const asset = assetParam;
  const clientKey = request.headers.get("cf-connecting-ip") ?? undefined;

  // Before any cache read: cached responses must not outlive a repo turning
  // private or the mirror being restricted.
  const denied = await checkGitHubMirrorAccess(env, owner, repo, {
    clientKey,
  });
  if (denied) return denied;

  // A published release rotates the generation, which moves the release list
  // to a new edge cache key and makes its stored page 1 stale.
  const generation =
    source === "releases"
      ? (await getGitHubLatestReleaseGenerations(env.GITHUB_CACHE, owner, repo))
          ?.current
      : undefined;
  const cacheKeyParams: Record<string, string> = { source };
  if (asset) cacheKeyParams.asset = asset;
  const cached = await matchGitHubMirrorEdgeCache(
    request,
    generation,
    cacheKeyParams,
  );
  if (cached) return cached;

  try {
    const { versions, edgeSeconds, staleFallback } =
      await getCachedGitHubVersions(
        env,
        owner,
        repo,
        { source, asset, generation, clientKey },
        { waitUntil: (promise) => locals.cfContext.waitUntil(promise) },
      );
    const headers = {
      browserMaxAge: 0,
      edgeMaxAge: edgeSeconds,
      staleWhileRevalidate: 0,
    };
    const response = jsonResponse(versions, 200, cacheHeaders(headers));
    // A stale fallback is served once but not edge-cached, so the next
    // request retries GitHub.
    if (staleFallback) return response;
    locals.cfContext.waitUntil(
      putGitHubMirrorEdgeCache(request, response, {
        ...headers,
        cacheGeneration: generation,
        cacheKeyParams,
      }),
    );
    return response;
  } catch (error) {
    if (error instanceof VersionsCrawlLimited) {
      return errorResponse("Too many uncached repository lookups", 429);
    }
    console.error(
      `GitHub versions mirror failed for ${owner}/${repo} (${source}):`,
      error,
    );
    return errorResponse(
      githubStatus(error) === 404
        ? "Not found"
        : "Failed to fetch GitHub versions",
      githubStatus(error) === 404 ? 404 : 502,
    );
  }
};
