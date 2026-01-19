// Custom worker wrapper that adds scheduled event handling to Astro's worker
// This allows us to use Cloudflare cron triggers for daily rollup tasks

import { drizzle } from "drizzle-orm/d1";
import { runMigrations } from "./migrations.js";
import { runAnalyticsMigrations, setupAnalytics } from "./analytics/index.js";
// @ts-expect-error - generated Astro worker bundle has no type declarations
import astroWorker from "../web/dist/_worker.js/index.js";

interface Env {
  DB: D1Database;
  ANALYTICS_DB: D1Database;
  API_SECRET: string;
  [key: string]: unknown;
}

// Re-export the Astro worker's fetch handler
export default {
  fetch: astroWorker.fetch,
  scheduled,
};

// Scheduled event handler for cron triggers
export async function scheduled(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  console.log("Running scheduled tasks via cron trigger...");

  try {
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
    const yesterdayMauStats = await analytics.populateDailyMauStats(
      yesterdayStr,
      env.ANALYTICS_DB,
    );
    console.log(
      `MAU stats for ${yesterdayStr}: ${yesterdayMauStats ? "updated" : "no data"}`,
    );

    const todayMauStats = await analytics.populateDailyMauStats(
      todayStr,
      env.ANALYTICS_DB,
    );
    console.log(
      `MAU stats for ${todayStr}: ${todayMauStats ? "updated" : "no data"}`,
    );

    console.log("Scheduled tasks completed successfully");
  } catch (error) {
    console.error("Scheduled task error:", error);
    throw error;
  }
}
