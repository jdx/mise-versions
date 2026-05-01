import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { runMigrations } from "../../../../../src/migrations";
import { env } from "cloudflare:workers";
import {
  runAnalyticsMigrations,
  setupAnalytics,
} from "../../../../../src/analytics";
import { jsonResponse, errorResponse } from "../../../lib/api";

// POST /api/admin/scheduled - Run scheduled tasks (called by cron)
// This endpoint handles the daily aggregation tasks
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    // Verify admin secret
    const authHeader = request.headers.get("Authorization");
    const expectedAuth = `Bearer ${env.API_SECRET}`;
    if (authHeader !== expectedAuth) {
      return errorResponse("Unauthorized", 401);
    }

    console.log("Running scheduled tasks...");

    // Run migrations first
    const db = drizzle(env.DB);
    await runMigrations(db);

    const analyticsDb = drizzle(env.ANALYTICS_DB);
    await runAnalyticsMigrations(analyticsDb);

    const analytics = setupAnalytics(analyticsDb);

    // 1. Aggregate old data (data older than 90 days)
    const aggregateResult = await analytics.aggregateOldData();
    console.log(
      `Aggregation complete: ${aggregateResult.aggregated} groups aggregated, ${aggregateResult.deleted} rows deleted`,
    );

    // 2. Populate rollup tables for yesterday (and today so far)
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];
    const todayStr = now.toISOString().split("T")[0];

    // Populate yesterday's full data
    const yesterdayResult = await analytics.populateRollupTables(
      yesterdayStr,
      env.ANALYTICS_DB,
    );
    console.log(
      `Rollup tables populated for ${yesterdayStr}: ${yesterdayResult.toolStats} tools, ${yesterdayResult.backendStats} backends`,
    );

    // Also update today's partial data
    const todayResult = await analytics.populateRollupTables(
      todayStr,
      env.ANALYTICS_DB,
    );
    console.log(
      `Rollup tables updated for ${todayStr}: ${todayResult.toolStats} tools, ${todayResult.backendStats} backends`,
    );

    // 3. Populate version stats rollup for DAU/MAU
    const yesterdayVersionStats = await analytics.populateVersionStatsRollup(
      yesterdayStr,
      env.ANALYTICS_DB,
    );
    console.log(
      `Version stats rollup for ${yesterdayStr}: ${yesterdayVersionStats ? "updated" : "no data"}`,
    );

    const todayVersionStats = await analytics.populateVersionStatsRollup(
      todayStr,
      env.ANALYTICS_DB,
    );
    console.log(
      `Version stats rollup for ${todayStr}: ${todayVersionStats ? "updated" : "no data"}`,
    );

    // 4. Populate daily MAU stats (trailing 30-day MAU for each date)
    // Recalculate the last 31 days to correct any stale/inflated values
    let mauDaysUpdated = 0;
    for (let i = 30; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      const result = await analytics.populateDailyMauStats(
        dateStr,
        env.ANALYTICS_DB,
      );
      if (result) mauDaysUpdated++;
    }
    console.log(`MAU stats recalculated for ${mauDaysUpdated} of 31 days`);

    // 5. Refresh summary tables used by hot UI read paths
    const summaries = await analytics.populateToolDownloadSummaries(
      env.ANALYTICS_DB,
    );
    console.log(
      `Download summaries refreshed: ${summaries.toolSummaries} tools, ${summaries.platformSummaries} platform rows, ${summaries.versionSummaries} version rows`,
    );

    return jsonResponse({
      success: true,
      aggregation: {
        aggregated: aggregateResult.aggregated,
        deleted: aggregateResult.deleted,
      },
      rollups: {
        yesterday: {
          date: yesterdayStr,
          toolStats: yesterdayResult.toolStats,
          backendStats: yesterdayResult.backendStats,
          toolBackendStats: yesterdayResult.toolBackendStats,
          combinedStats: yesterdayResult.combinedStats,
        },
        today: {
          date: todayStr,
          toolStats: todayResult.toolStats,
          backendStats: todayResult.backendStats,
          toolBackendStats: todayResult.toolBackendStats,
          combinedStats: todayResult.combinedStats,
        },
      },
      versionStats: {
        yesterday: yesterdayVersionStats,
        today: todayVersionStats,
      },
      mauStats: {
        daysUpdated: mauDaysUpdated,
      },
      summaries,
    });
  } catch (error) {
    console.error("Scheduled task error:", error);
    return errorResponse(`Failed to run scheduled tasks: ${error}`, 500);
  }
};
