import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getMiseReleaseDailyBinaryDownloads } from "../../../../../src/analytics/mise-releases";
import { cachedJsonResponse, errorResponse } from "../../../lib/api";

// GET /api/mise-releases/daily (public)
//
// Release binary requests on mise.jdx.dev / mise.en.dev for each fully
// covered UTC day, oldest first. jdx.dev adds them to the GitHub release-asset
// downloads it shows for mise. The data only changes once a night, so the edge
// caches it for an hour.
export const GET: APIRoute = async () => {
  try {
    return cachedJsonResponse(
      { days: await getMiseReleaseDailyBinaryDownloads(env.ANALYTICS_DB) },
      "public, max-age=3600",
    );
  } catch (error) {
    console.error("Get mise release daily downloads error:", error);
    return errorResponse("Failed to get mise release daily downloads", 500);
  }
};
