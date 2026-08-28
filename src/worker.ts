/// <reference path="./astro-worker.d.ts" />

// Custom worker wrapper for Astro's worker bundle.

import astroWorker from "../web/dist/server/entry.mjs";
import { drizzle } from "drizzle-orm/d1";
import { ensureTokenObservabilitySchema } from "./migrations.js";
import { observeTokenPool } from "./token-observability.js";
import {
  dispatchUpdateWorkflow,
  UPDATE_WORKFLOW_CRON,
} from "./workflow-dispatch.js";

const TOKEN_OBSERVABILITY_CRON = "*/15 * * * *";

function isMissingTokenObservabilitySchema(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("no such table") && message.includes("token_");
}

async function observeWithSchemaRetry(env: Env): Promise<void> {
  try {
    await observeTokenPool(env);
  } catch (error) {
    if (!isMissingTokenObservabilitySchema(error)) throw error;

    await ensureTokenObservabilitySchema(drizzle(env.DB));
    await observeTokenPool(env);
  }
}

export default {
  fetch: astroWorker.fetch,
  async scheduled(controller, env, ctx) {
    switch (controller.cron) {
      case TOKEN_OBSERVABILITY_CRON:
        ctx.waitUntil(
          observeWithSchemaRetry(env).catch((error: unknown) => {
            console.error("token_observability_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }),
        );
        break;
      case UPDATE_WORKFLOW_CRON:
        ctx.waitUntil(
          dispatchUpdateWorkflow(env.GITHUB_ACTIONS_TOKEN)
            .then((result) => {
              console.info("update_workflow_dispatched", {
                github_request_id: result.requestId,
                scheduled_time: controller.scheduledTime,
              });
            })
            .catch((error: unknown) => {
              console.error("update_workflow_dispatch_failed", {
                error: error instanceof Error ? error.message : String(error),
                scheduled_time: controller.scheduledTime,
              });
              throw error;
            }),
        );
        break;
      default:
        console.warn("unknown_scheduled_trigger", { cron: controller.cron });
    }
  },
} satisfies ExportedHandler<Env>;
