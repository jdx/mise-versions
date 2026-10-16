import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../../../lib/api";
import {
  cacheHeaders,
  getCachedGitHubReleaseResult,
  gitHubMirrorMutableSnippetCopy,
  gitHubMirrorReleaseSnippetCacheKey,
  githubStatus,
  matchGitHubMirrorEdgeCache,
  matchGitHubMirrorSnippetCache,
  putGitHubMirrorEdgeCache,
  putGitHubMirrorSnippetCache,
  releaseCacheHeaders,
  releaseEdgeCacheOptions,
  validReleaseTag,
  validRepoPart,
} from "../../../../../../../lib/github/mirror";
import { checkGitHubMirrorAccessVerified } from "../../../../../../../lib/github/visibility";
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
  const access = await checkGitHubMirrorAccessVerified(env, owner, repo, {
    clientKey: request.headers.get("cf-connecting-ip") ?? undefined,
  });
  if (access.denied) return access.denied;
  const waitUntil = (promise: Promise<unknown>) =>
    locals.cfContext.waitUntil(promise);

  const cacheGenerations =
    tag === "latest"
      ? await getGitHubLatestReleaseGenerations(env.GITHUB_CACHE, owner, repo)
      : undefined;
  const cacheGeneration = cacheGenerations?.current;
  // An exact tag is kept where the GitHub-mirror snippet can answer it
  // without the Worker; `latest` changes in place and stays here.
  const snippetKey = gitHubMirrorReleaseSnippetCacheKey(request, tag);
  // `latest` keeps its generation-keyed cache here; the snippet gets a
  // short-lived copy of the current generation's answer.
  const snippetCopy =
    tag === "latest"
      ? gitHubMirrorMutableSnippetCopy(request, {
          ttl: env.GITHUB_MIRROR_SNIPPET_TTL_SECONDS,
          verifiedAt: access.verifiedAt,
          verifiedUntil: access.verifiedUntil,
          waitUntil,
        })
      : undefined;
  const cached = snippetKey
    ? await matchGitHubMirrorSnippetCache(
        snippetKey,
        access.verifiedAt,
        waitUntil,
        access.verifiedUntil,
      )
    : await matchGitHubMirrorEdgeCache(
        request,
        cacheGeneration,
        undefined,
        snippetCopy,
      );
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
    const response = jsonResponse(release, 200, {
      ...(staleFallback
        ? cacheHeaders({
            browserMaxAge: 0,
            edgeMaxAge: 0,
            staleWhileRevalidate: 0,
          })
        : releaseCacheHeaders(tag, release, cacheGeneration)),
      "x-mise-mirror": "worker",
    });
    // A stale fallback is never cached, here or for the snippet.
    if (!staleFallback) {
      const edgeOptions = {
        ...releaseEdgeCacheOptions(tag, release, cacheGeneration),
        snippet: snippetCopy,
      };
      waitUntil(
        snippetKey
          ? putGitHubMirrorSnippetCache(
              snippetKey,
              response,
              edgeOptions,
              access.verifiedAt,
              access.verifiedUntil,
            )
          : putGitHubMirrorEdgeCache(request, response, edgeOptions),
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
