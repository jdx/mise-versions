import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../lib/api";
import {
  cacheHeaders,
  githubStatus,
  matchGitHubMirrorEdgeCache,
  putGitHubMirrorEdgeCache,
} from "../../../../../lib/github/mirror";
import { getGitHubLatestReleaseGenerations } from "../../../../../lib/github/release-generation";
import {
  getCachedGitHubVersions,
  parseVersionsPath,
  VersionsCrawlLimited,
} from "../../../../../lib/github/versions";
import { checkGitHubMirrorAccess } from "../../../../../lib/github/visibility";

// GET /data/github/{owner}/{repo}/releases.json
// GET /data/github/{owner}/{repo}/tags.json
// GET /data/github/{owner}/{repo}/assets/{asset}/releases.json
//
// A repository's whole release or tag list, compacted. Every deploy bakes the
// lists clients have asked for into static assets at these paths, which are
// served without invoking the Worker; this route only answers the rest (a
// list nobody has asked for yet, or one asked for since the last deploy). The
// client contract is docs/github-versions.md.
export const GET: APIRoute = async ({ request, locals }) => {
  const target = parseVersionsPath(new URL(request.url).pathname);
  if (!target) {
    return errorResponse(
      "Not a GitHub versions path (owner and repo must be lowercase)",
      404,
    );
  }
  const { owner, repo, source, asset } = target;
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
  const cached = await matchGitHubMirrorEdgeCache(request, generation);
  if (cached) return cached;

  try {
    const { versions, edgeSeconds, staleFallback } =
      await getCachedGitHubVersions(
        env,
        owner,
        repo,
        { source, asset, generation, clientKey, demand: true },
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
