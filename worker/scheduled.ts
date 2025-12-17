// Scheduled handlers and migrations
import { drizzle } from "drizzle-orm/d1";
import { Env, getDb } from "./shared";
import { runMigrations } from "../src/migrations";
import { runAnalyticsMigrations, setupAnalytics } from "../src/analytics";

let migrationsCompleted = false;

// Run migrations once on first request
export async function ensureMigrations(env: Env): Promise<void> {
  if (migrationsCompleted) return;

  try {
    console.log("Running database migrations...");
    const db = getDb(env);
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

// Scheduled handler for daily aggregation (runs at midnight UTC)
export async function handleScheduled(env: Env): Promise<void> {
  console.log("Running scheduled tasks...");

  const analyticsDb = drizzle(env.ANALYTICS_DB);
  const analytics = setupAnalytics(analyticsDb);

  // 1. Aggregate old data (data older than 90 days)
  const aggregateResult = await analytics.aggregateOldData();
  console.log(
    `Aggregation complete: ${aggregateResult.aggregated} groups aggregated, ${aggregateResult.deleted} rows deleted`
  );

  // 2. Populate rollup tables for yesterday (and today so far)
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];
  const todayStr = now.toISOString().split("T")[0];

  // Populate yesterday's full data
  const yesterdayResult = await analytics.populateRollupTables(yesterdayStr);
  console.log(
    `Rollup tables populated for ${yesterdayStr}: ${yesterdayResult.toolStats} tools, ${yesterdayResult.backendStats} backends`
  );

  // Also update today's partial data
  const todayResult = await analytics.populateRollupTables(todayStr);
  console.log(
    `Rollup tables updated for ${todayStr}: ${todayResult.toolStats} tools, ${todayResult.backendStats} backends`
  );
}
