import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../../../lib/api";
import {
  ATTESTATION_FRESH_SECONDS,
  attestationsCacheHeaders,
  getCachedGitHubAttestations,
  githubStatus,
  matchGitHubMirrorEdgeCache,
  putGitHubMirrorEdgeCache,
  validDigest,
  validRepoPart,
} from "../../../../../../../lib/github/mirror";
import { checkGitHubMirrorAccess } from "../../../../../../../lib/github/visibility";

export const GET: APIRoute = async ({ params, request, locals }) => {
  const { owner, repo, digest } = params;
  if (!validRepoPart(owner) || !validRepoPart(repo) || !validDigest(digest)) {
    return errorResponse("Invalid GitHub attestation path", 400);
  }

  // Before any cache read: cached responses must not outlive a repo turning
  // private or the mirror being restricted.
  const denied = await checkGitHubMirrorAccess(env, owner, repo, {
    attestations: true,
  });
  if (denied) return denied;

  const cached = await matchGitHubMirrorEdgeCache(request);
  if (cached) return cached;

  try {
    const attestations = await getCachedGitHubAttestations(
      env,
      owner,
      repo,
      digest,
    );
    const response = jsonResponse(
      attestations,
      200,
      attestationsCacheHeaders(),
    );
    locals.cfContext.waitUntil(
      putGitHubMirrorEdgeCache(request, response, {
        browserMaxAge: ATTESTATION_FRESH_SECONDS,
        edgeMaxAge: ATTESTATION_FRESH_SECONDS,
        staleWhileRevalidate: 0,
      }),
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
