/// <reference path="./astro-worker.d.ts" />

// Custom worker wrapper for Astro's worker bundle.

import astroWorker from "../web/dist/server/entry.mjs";
import { drizzle } from "drizzle-orm/d1";
import { ensureTokenObservabilitySchema } from "./migrations.js";
import { observeTokenPool } from "./token-observability.js";

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
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      observeWithSchemaRetry(env).catch((error: unknown) => {
        console.error("token_observability_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  },
} satisfies ExportedHandler<Env>;
