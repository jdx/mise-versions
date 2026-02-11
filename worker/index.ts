// Cloudflare Worker entry point
// Wraps Astro's generated worker and adds scheduled handler support
import { drizzle } from "drizzle-orm/d1";
import { runMigrations } from "../src/migrations.js";
import {
  runAnalyticsMigrations,
  setupAnalytics,
} from "../src/analytics/index.js";

// Type for environment bindings
interface Env {
  DB: D1Database;
  ANALYTICS_DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_CACHE: KVNamespace;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  API_SECRET: string;
}

let migrationsCompleted = false;

// Run migrations once
async function ensureMigrations(env: Env): Promise<void> {
  if (migrationsCompleted) return;

  try {
    console.log("Running database migrations...");
    const db = drizzle(env.DB);
    await runMigrations(db);

    // Run analytics database migrations
    const analyticsDb = drizzle(env.ANALYTICS_DB);
    await runAnalyticsMigrations(analyticsDb);

    migrationsCompleted = true;
    console.log("Migrations completed");
  } catch (error) {
    console.error("Migration error:", error);
  }
}

// Dynamically import Astro's handler (built by Astro at build time)
async function getAstroHandler() {
  // @ts-expect-error - This path is generated at build time by Astro
  const astroModule = await import("../web/dist/_worker.js/index.js");
  return astroModule.default;
}

export default {
  // Forward fetch requests to Astro
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Run migrations once on first request
    await ensureMigrations(env);

    // Forward to Astro's handler
    const astroApp = await getAstroHandler();
    return astroApp.fetch(request, env, ctx);
  },

  // Cron trigger for daily aggregation
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    console.log("Running scheduled tasks...");

    // Ensure migrations are run
    await ensureMigrations(env);

    const analyticsDb = drizzle(env.ANALYTICS_DB);
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
  },
};
