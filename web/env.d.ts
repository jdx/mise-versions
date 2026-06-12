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
  DOWNLOAD_DEDUPE: KVNamespace;
  ANALYTICS_EVENTS?: AnalyticsEngineDataset;
  ANALYTICS_ENGINE_ACCOUNT_ID?: string;
  ANALYTICS_ENGINE_API_TOKEN?: string;
  ANALYTICS_ENGINE_DATASET?: string;
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

declare module "snappyjs" {
  export function uncompress(input: Uint8Array): Uint8Array;
}
