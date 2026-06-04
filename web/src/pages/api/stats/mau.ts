import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupAnalytics } from "../../../../../src/analytics";
import { env } from "cloudflare:workers";
import {
  cachedJsonResponse,
  errorResponse,
} from "../../../lib/api";

// GET /api/stats/mau - Get monthly active users (public)
export const GET: APIRoute = async ({ locals }) => {
  try {
    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const mau = await analytics.getMAU();

    return cachedJsonResponse(
      { mau },
      "public, max-age=300, stale-while-revalidate=600",
    );
  } catch (error) {
    console.error("Get MAU error:", error);
    return errorResponse("Failed to get MAU", 500);
  }
};
