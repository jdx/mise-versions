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
  console.log("Running scheduled aggregation...");

  const analyticsDb = drizzle(env.ANALYTICS_DB);
  const analytics = setupAnalytics(analyticsDb);

  const result = await analytics.aggregateOldData();
  console.log(
    `Aggregation complete: ${result.aggregated} groups aggregated, ${result.deleted} rows deleted`
  );
}
