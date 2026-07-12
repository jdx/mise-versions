// Custom worker wrapper for Astro's worker bundle.

// @ts-ignore - the generated Astro bundle may not exist yet and has no declarations
import astroWorker from "../web/dist/server/entry.mjs";

// Re-export the Astro worker's fetch handler
export default {
  fetch: astroWorker.fetch,
};
