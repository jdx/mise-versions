import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupDatabase } from "../../../../src/database";
import { errorResponse, requireApiAuth } from "../../lib/api";

// GitHub proxy
export const ALL: APIRoute = async ({ request, locals, params }) => {
  const env = locals.runtime.env;
  const ctx = locals.runtime.ctx;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse("Method Not Allowed", 405);
  }

  // Require API auth
  const authError = requireApiAuth(request, env.API_SECRET);
  if (authError) return authError;

  // Database setup
  const db = drizzle(env.DB);
  const database = setupDatabase(db);

  // Trigger deactivation
  ctx.waitUntil(
    database
      .deactivateExpiredTokens()
      .catch(console.error)
  );

  // Retry loop (max 3 attempts)
  for (let attempt = 0; attempt < 3; attempt++) {
    // Get GitHub token
    const token = await database.getNextToken();
    if (!token) {
      return errorResponse("No GitHub tokens available", 503);
    }

    // Construct upstream URL
    const path = params.path ?? "";
    const url = new URL(request.url);
    const upstreamUrl = new URL(`https://api.github.com/${path}${url.search}`);

    // Forward request
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${token.token}`);

    try {
      const response = await fetch(upstreamUrl.toString(), {
        method: request.method,
        headers,
      });

      // Handle rate limits and errors
      const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
      const rateLimitReset = response.headers.get("x-ratelimit-reset");

      let isRateLimited = false;
      if (
        response.status === 403 ||
        response.status === 429 ||
        response.status === 401
      ) {
        if (
          (rateLimitRemaining === "0" && rateLimitReset) ||
          response.status === 429
        ) {
          isRateLimited = true;
          console.warn(
            `Token ${token.id} rate limited (${response.status}). Marking as rate limited.`,
          );

          // Default to 1 hour if no reset header/invalid for 429
          let resetDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
          if (rateLimitReset) {
            resetDate = new Date(parseInt(rateLimitReset) * 1000).toISOString();
          } else if (response.headers.get("retry-after")) {
            const retryAfter = parseInt(response.headers.get("retry-after")!);
            resetDate = new Date(Date.now() + retryAfter * 1000).toISOString();
          }

          await database.markTokenRateLimited(token.id, resetDate);
        } else if (response.status === 401) {
          console.warn(
            `Token ${token.id} unauthorized (401). Maybe expired/revoked.`,
          );
        }
      }

      const shouldRetry =
        (isRateLimited || response.status === 401) && attempt < 2;

      if (!shouldRetry) {
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
    } catch (err) {
      console.error("Proxy error:", err);
      // Capture error as response if possible, or just fail
      return errorResponse(
        `Proxy error: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }
  }

  return errorResponse("Retries exhausted", 502);
};
