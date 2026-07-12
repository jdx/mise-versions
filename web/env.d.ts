/// <reference path="./.astro/types.d.ts" />
/// <reference path="../worker-configuration.d.ts" />
/// <reference types="astro/client" />

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

declare namespace App {
  interface Locals extends Runtime {}
}

declare module "snappyjs" {
  export function uncompress(input: Uint8Array): Uint8Array;
}
