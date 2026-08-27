/// <reference path="./astro-worker.d.ts" />

// Custom worker wrapper for Astro's worker bundle.

import astroWorker from "../web/dist/server/entry.mjs";
import { drizzle } from "drizzle-orm/d1";
import { runMigrations } from "./migrations.js";
import { observeTokenPool } from "./token-observability.js";

export default {
  fetch: astroWorker.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runMigrations(drizzle(env.DB), { quiet: true })
        .then(() => observeTokenPool(env))
        .catch((error: unknown) => {
          console.error("token_observability_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
    );
  },
} satisfies ExportedHandler<Env>;
