import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../../../lib/api";
import {
  attestationsCacheHeaders,
  getCachedGitHubAttestations,
  githubStatus,
  matchGitHubMirrorEdgeCache,
  putGitHubMirrorEdgeCache,
  validDigest,
  validRepoPart,
} from "../../../../../../../lib/github/mirror";
import {
  isKnownGitHubAttestationRepo,
  isRegisteredGitHubRepo,
} from "../../../../../../../lib/github/registry";

export const GET: APIRoute = async ({ params, request, locals }) => {
  const { owner, repo, digest } = params;
  if (!validRepoPart(owner) || !validRepoPart(repo) || !validDigest(digest)) {
    return errorResponse("Invalid GitHub attestation path", 400);
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
  if (!registered && !isKnownGitHubAttestationRepo(owner, repo)) {
    return errorResponse("GitHub repo is not in the mise registry", 403);
  }

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
      attestationsCacheHeaders(attestations),
    );
    locals.cfContext.waitUntil(putGitHubMirrorEdgeCache(request, response));
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
