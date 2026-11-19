import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../../../lib/api";
import {
  ATTESTATION_FRESH_SECONDS,
  attestationsCacheHeaders,
  deniedGitHubMirrorResponse,
  getCachedGitHubAttestationsResult,
  gitHubMirrorSnippetCacheKey,
  githubStatus,
  matchGitHubMirrorEdgeCache,
  matchGitHubMirrorSnippetCache,
  putGitHubMirrorEdgeCache,
  putGitHubMirrorSnippetCache,
  validDigest,
  validRepoPart,
} from "../../../../../../../lib/github/mirror";
import { checkGitHubMirrorAccessVerified } from "../../../../../../../lib/github/visibility";

export const GET: APIRoute = async ({ params, request, locals }) => {
  const { owner, repo, digest } = params;
  if (!validRepoPart(owner) || !validRepoPart(repo) || !validDigest(digest)) {
    return errorResponse("Invalid GitHub attestation path", 400);
  }

  // Before any cache read: cached responses must not outlive a repo turning
  // private or the mirror being restricted.
  const access = await checkGitHubMirrorAccessVerified(env, owner, repo, {
    attestations: true,
    clientKey: request.headers.get("cf-connecting-ip") ?? undefined,
  });
  if (access.denied) {
    return deniedGitHubMirrorResponse(request, access, (promise) =>
      locals.cfContext.waitUntil(promise),
    );
  }

  // Kept where the GitHub-mirror snippet can answer it without the Worker.
  const snippetKey = gitHubMirrorSnippetCacheKey(request);
  const waitUntil = (promise: Promise<unknown>) =>
    locals.cfContext.waitUntil(promise);
  const cached = snippetKey
    ? await matchGitHubMirrorSnippetCache(
        snippetKey,
        access.verifiedAt,
        waitUntil,
        access.verifiedUntil,
      )
    : await matchGitHubMirrorEdgeCache(request);
  if (cached) return cached;

  try {
    const { attestations, freshForSeconds } =
      await getCachedGitHubAttestationsResult(env, owner, repo, digest);
    const response = jsonResponse(attestations, 200, {
      ...attestationsCacheHeaders(freshForSeconds),
      "x-mise-mirror": "worker",
    });
    // Edge copies (the Worker's and the snippet's, which is still bounded by
    // the access check's verification window) live as long as the KV entry
    // stays fresh: the Worker would serve the same answer until then.
    const edgeOptions = {
      browserMaxAge: ATTESTATION_FRESH_SECONDS,
      edgeMaxAge: freshForSeconds,
      staleWhileRevalidate: 0,
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
    return response;
  } catch (error) {
    console.error(
      `GitHub attestation mirror failed for ${owner}/${repo}@${digest}:`,
      error,
    );
    return errorResponse(
      githubStatus(error) === 404
        ? "Not found"
        : "Failed to fetch GitHub attestations",
      githubStatus(error) === 404 ? 404 : 502,
    );
  }
};
