/// <reference path="./astro-worker.d.ts" />

// Custom worker wrapper for Astro's worker bundle.

import astroWorker from "../web/dist/server/entry.mjs";

// Re-export the Astro worker's fetch handler
export default {
  fetch: astroWorker.fetch,
};
