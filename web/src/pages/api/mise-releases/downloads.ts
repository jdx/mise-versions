import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  getMiseReleaseDownloads,
  MISE_RELEASE_DOWNLOADS_MAX_DAYS,
  parseMiseReleaseDays,
} from "../../../../../src/analytics/mise-releases";
import { cachedJsonResponse, errorResponse } from "../../../lib/api";

// GET /api/mise-releases/downloads?days=30 (public)
//
// Requests for each mise release folder on mise.jdx.dev / mise.en.dev over
// the `days` most recent fully covered UTC days, from Logpush. The data only
// changes once a night, so the edge caches it for an hour.
export const GET: APIRoute = async ({ url }) => {
  const days = parseMiseReleaseDays(url.searchParams.get("days"));
  if (days === null) {
    return errorResponse(
      `days must be an integer from 1 to ${MISE_RELEASE_DOWNLOADS_MAX_DAYS}`,
    );
  }
  try {
    return cachedJsonResponse(
      await getMiseReleaseDownloads(env.ANALYTICS_DB, days),
      "public, max-age=3600",
    );
  } catch (error) {
    console.error("Get mise release downloads error:", error);
    return errorResponse("Failed to get mise release downloads", 500);
  }
};
