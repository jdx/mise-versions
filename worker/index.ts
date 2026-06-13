// Cloudflare Worker entry point
// Wraps Astro's generated worker and adds scheduled handler support
import { drizzle } from "drizzle-orm/d1";
import { runMigrations } from "../src/migrations.js";
import { runAnalyticsMigrations } from "../src/analytics/index.js";
import { runMaintenancePipeline } from "../src/maintenance-pipeline.js";

// Type for environment bindings
interface Env {
  DB: D1Database;
  ANALYTICS_DB: D1Database;
  ANALYTICS_EVENTS?: AnalyticsEngineDataset;
  ANALYTICS_ENGINE_ACCOUNT_ID?: string;
  ANALYTICS_ENGINE_API_TOKEN?: string;
  ANALYTICS_ENGINE_DATASET?: string;
  ANALYTICS_ENGINE_CUTOVER_DATE?: string;
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

    const result = await runMaintenancePipeline(env);
    for (const step of result.steps) {
      if (step.ok) {
        console.log(`Scheduled ${step.name} complete:`, step.detail);
      } else {
        console.error(`Scheduled ${step.name} failed:`, step.error);
      }
    }
  },
};
