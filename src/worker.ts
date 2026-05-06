// Custom worker wrapper that adds scheduled event handling to Astro's worker
// This allows us to use Cloudflare cron triggers for daily rollup tasks

import { drizzle } from "drizzle-orm/d1";
import { runMigrations } from "./migrations.js";
import { runAnalyticsMigrations, setupAnalytics } from "./analytics/index.js";
// @ts-expect-error - generated Astro worker bundle has no type declarations
import astroWorker from "../web/dist/server/entry.mjs";

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

  // Migrations are pre-requisites for everything else, so they run outside
  // the per-step isolation below. If they fail, fail loud.
  const db = drizzle(env.DB);
  await runMigrations(db);

  const analyticsDb = drizzle(env.ANALYTICS_DB);
  await runAnalyticsMigrations(analyticsDb);

  const analytics = setupAnalytics(analyticsDb);

  const now = new Date();

  // Run each section in isolation. aggregateOldData scans the full downloads
  // table and has been blowing past D1 subrequest limits, which previously
  // also took out the rollup steps that ran after it.
  await runStep("aggregate", async () => {
    const r = await analytics.aggregateOldData();
    console.log(
      `Aggregation: ${r.aggregated} groups aggregated, ${r.deleted} rows deleted`,
    );
  });

  // Backfill the last 31 days of rollup + MAU tables. This makes the cron
  // self-healing: any day previously missed (e.g. while aggregateOldData was
  // throwing) gets refilled on the next successful run.
  await runStep("rollup", async () => {
    let ok = 0;
    for (let i = 30; i >= 0; i--) {
      const dateStr = dateStrAgo(now, i);
      try {
        await analytics.populateRollupTables(dateStr, env.ANALYTICS_DB);
        ok++;
      } catch (e) {
        console.error(`populateRollupTables failed for ${dateStr}:`, e);
      }
    }
    console.log(`Rollup tables refreshed for ${ok}/31 days`);
  });

  await runStep("version-stats", async () => {
    let ok = 0;
    for (let i = 30; i >= 0; i--) {
      const dateStr = dateStrAgo(now, i);
      try {
        await analytics.populateVersionStatsRollup(dateStr, env.ANALYTICS_DB);
        ok++;
      } catch (e) {
        console.error(`populateVersionStatsRollup failed for ${dateStr}:`, e);
      }
    }
    console.log(`Version stats refreshed for ${ok}/31 days`);
  });

  await runStep("mau", async () => {
    let ok = 0;
    for (let i = 30; i >= 0; i--) {
      const dateStr = dateStrAgo(now, i);
      try {
        await analytics.populateDailyMauStats(dateStr, env.ANALYTICS_DB);
        ok++;
      } catch (e) {
        console.error(`populateDailyMauStats failed for ${dateStr}:`, e);
      }
    }
    console.log(`MAU stats refreshed for ${ok}/31 days`);
  });

  await runStep("download-summaries", async () => {
    const s = await analytics.populateToolDownloadSummaries(env.ANALYTICS_DB);
    console.log(
      `Download summaries: ${s.toolSummaries} tools, ${s.platformSummaries} platforms, ${s.versionSummaries} versions`,
    );
  });

  await runStep("backend-summaries", async () => {
    const s = await analytics.populateBackendToolSummaries(env.ANALYTICS_DB);
    console.log(`Backend summaries: ${s.backendSummaries} rows`);
  });

  await runStep("trending-summaries", async () => {
    const s = await analytics.populateTrendingToolSummaries(env.ANALYTICS_DB);
    console.log(`Trending summaries: ${s.trendingSummaries} tools`);
  });

  console.log("Scheduled tasks finished");
}

function dateStrAgo(now: Date, daysAgo: number): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().split("T")[0];
}

async function runStep(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`Scheduled step '${name}' failed:`, e);
  }
}
