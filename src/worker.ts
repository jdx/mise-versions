/// <reference path="./astro-worker.d.ts" />

// Custom worker wrapper for Astro's worker bundle.

import astroWorker from "../web/dist/server/entry.mjs";
import { drizzle } from "drizzle-orm/d1";
import { ensureTokenObservabilitySchema } from "./migrations.js";
import {
  cleanupDeadTokens,
  DEAD_TOKEN_CLEANUP_CRON,
} from "./dead-token-cleanup.js";
import { observeTokenPool } from "./token-observability.js";
import {
  dispatchUpdateWorkflow,
  UPDATE_WORKFLOW_CRON,
} from "./workflow-dispatch.js";

const TOKEN_OBSERVABILITY_CRON = "*/15 * * * *";
// The GitHub version-list refresher (web/src/lib/github/versions.ts), run
// through its admin route so the Astro bundle keeps the code.
const GITHUB_VERSIONS_REFRESH_CRON = "*/10 * * * *";
const GITHUB_VERSIONS_REFRESH_URL =
  "https://mise-versions.jdx.dev/api/admin/github/versions/refresh";

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
      case DEAD_TOKEN_CLEANUP_CRON:
        ctx.waitUntil(
          cleanupDeadTokens(env).catch((error: unknown) => {
            console.error("dead_token_cleanup_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }),
        );
        break;
      case GITHUB_VERSIONS_REFRESH_CRON:
        // Handled in-process by the Astro bundle: no network request.
        ctx.waitUntil(
          Promise.resolve(
            astroWorker.fetch(
              new Request(GITHUB_VERSIONS_REFRESH_URL, {
                method: "POST",
                headers: { Authorization: `Bearer ${env.API_SECRET}` },
              }),
              env,
              ctx,
            ),
          )
            .then(async (response) => {
              const run = await response.text();
              if (!response.ok) {
                throw new Error(`refresh answered ${response.status}: ${run}`);
              }
              console.info("github_versions_refreshed", run);
            })
            .catch((error: unknown) => {
              console.error("github_versions_refresh_failed", {
                error: error instanceof Error ? error.message : String(error),
              });
            }),
        );
        break;
      default:
        console.warn("unknown_scheduled_trigger", { cron: controller.cron });
    }
  },
} satisfies ExportedHandler<Env>;
