import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupAnalytics } from "../../../../../src/analytics";
import {
  cachedJsonResponse,
  errorResponse,
  CACHE_CONTROL,
} from "../../../lib/api";

// GET /api/stats/mau - Get monthly active users (public)
export const GET: APIRoute = async ({ locals }) => {
  try {
    const runtime = locals.runtime;
    const db = drizzle(runtime.env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const mau = await analytics.getMAU();

    return cachedJsonResponse({ mau }, CACHE_CONTROL.API);
  } catch (error) {
    console.error("Get MAU error:", error);
    return errorResponse("Failed to get MAU", 500);
  }
};
