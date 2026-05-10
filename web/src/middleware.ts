import { defineMiddleware } from "astro:middleware";

// Cacheability is a property of the response, not the URL path. Each route
// is responsible for setting an explicit Cache-Control header. If a route
// forgets, default to `private, no-store` so the failure mode is "not cached"
// (cost/perf hit) rather than "cached" (data leak). Combined with the
// mise-versions edge cache rule's `respect_origin` mode, this means routes
// must opt-in to caching by setting a public Cache-Control header.
export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  if (!response.headers.has("Cache-Control")) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
});
