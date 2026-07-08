// Custom worker wrapper for Astro's worker bundle.

// @ts-expect-error - generated Astro worker bundle has no type declarations
import astroWorker from "../web/dist/server/entry.mjs";

// Re-export the Astro worker's fetch handler
export default {
  fetch: astroWorker.fetch,
};
