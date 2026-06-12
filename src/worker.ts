// Custom worker wrapper that adds scheduled event handling to Astro's worker
// This allows us to use Cloudflare cron triggers for daily rollup tasks

import { runMaintenancePipeline } from "./maintenance-pipeline.js";
// @ts-expect-error - generated Astro worker bundle has no type declarations
import astroWorker from "../web/dist/server/entry.mjs";

interface Env {
  DB: D1Database;
  ANALYTICS_DB: D1Database;
  ANALYTICS_EVENTS?: AnalyticsEngineDataset;
  ANALYTICS_ENGINE_ACCOUNT_ID?: string;
  ANALYTICS_ENGINE_API_TOKEN?: string;
  ANALYTICS_ENGINE_DATASET?: string;
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
  const result = await runMaintenancePipeline(env);
  const failed = result.steps.filter((s) => !s.ok).map((s) => s.name);
  console.log(
    `Scheduled tasks finished: ${result.steps.length - failed.length}/${result.steps.length} steps ok` +
      (failed.length ? ` (failed: ${failed.join(", ")})` : ""),
  );
}
