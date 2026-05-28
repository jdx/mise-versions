import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { errorResponse, jsonResponse } from "../../../../../../../lib/api";
import {
  cacheHeaders,
  getCachedGitHubRelease,
  githubStatus,
  validReleaseTag,
  validRepoPart,
} from "../../../../../../../lib/github/mirror";

export const GET: APIRoute = async ({ params }) => {
  const { owner, repo, tag } = params;
  if (!validRepoPart(owner) || !validRepoPart(repo) || !validReleaseTag(tag)) {
    return errorResponse("Invalid GitHub release path", 400);
  }

  try {
    const release = await getCachedGitHubRelease(env, owner, repo, tag);
    return jsonResponse(release, 200, cacheHeaders());
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
