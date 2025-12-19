/// <reference path="./.astro/types.d.ts" />
/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

// Minimal runtime typing for Astro on Cloudflare.
// We intentionally avoid importing `@astrojs/cloudflare` here because some tooling
// resolves types from the repo root (not the `web/` workspace), which can cause
// false-negative "Cannot find module" errors.
type Runtime = {
  runtime: {
    env: Env;
    ctx: ExecutionContext;
  };
};

interface Env {
  DB: D1Database;
  ANALYTICS_DB: D1Database;
  DATA_BUCKET: R2Bucket;
  GITHUB_CACHE: KVNamespace;
  MISE_VERSIONS_STREAM_STREAM: import("../src/pipelines").PipelinesStreamBinding;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  API_SECRET: string;
}

declare namespace App {
  interface Locals extends Runtime {}
}
