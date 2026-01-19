import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupAnalytics } from "../../../../../src/analytics";
import { jsonResponse, errorResponse } from "../../../lib/api";

// POST /api/admin/backfill-rollups - Backfill rollup tables for historical data (requires auth)
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const runtime = locals.runtime;

    // Verify admin secret
    const authHeader = request.headers.get("Authorization");
    const expectedAuth = `Bearer ${runtime.env.API_SECRET}`;
    if (authHeader !== expectedAuth) {
      return errorResponse("Unauthorized", 401);
    }

    const body = (await request.json()) as { days?: number };
    const days = body.days || 90;

    const db = drizzle(runtime.env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const result = await analytics.backfillRollupTables(
      days,
      runtime.env.ANALYTICS_DB,
    );

    return jsonResponse({
      success: true,
      days_processed: result.daysProcessed,
      mau_days_processed: result.mauDaysProcessed,
    });
  } catch (error) {
    console.error("Backfill rollups error:", error);
    return errorResponse(`Failed to backfill rollups: ${error}`, 500);
  }
};
