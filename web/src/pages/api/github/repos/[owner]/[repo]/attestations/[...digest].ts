import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../../../lib/api";
import {
  attestationsCacheHeaders,
  getCachedGitHubAttestations,
  githubStatus,
  validDigest,
  validRepoPart,
} from "../../../../../../../lib/github/mirror";

export const GET: APIRoute = async ({ params }) => {
  const { owner, repo, digest } = params;
  if (!validRepoPart(owner) || !validRepoPart(repo) || !validDigest(digest)) {
    return errorResponse("Invalid GitHub attestation path", 400);
  }

  try {
    const attestations = await getCachedGitHubAttestations(
      env,
      owner,
      repo,
      digest,
    );
    return jsonResponse(
      attestations,
      200,
      attestationsCacheHeaders(attestations),
    );
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
