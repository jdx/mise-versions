// Cloudflare Worker entry point
import { drizzle } from "drizzle-orm/d1";
import { Env, CORS_HEADERS, getDb, CACHE_CONTROL } from "./shared";
import { Router } from "./router";
import { handleLogin, handleCallback, handleMe, handleLogout } from "./routes/auth";
import {
  handleGetToken,
  handleRateLimitToken,
  handleStats,
  handleMigrations,
  handleRateLimits,
  handleGithubRepo,
} from "./routes/api";
import {
  handleTrack,
  handleGetToolDownloads,
  handleGetAllDownloads,
  handleGet30DayDownloads,
  handleGetMAU,
  handleAggregate,
} from "./routes/track";
import { handleHealth } from "./routes/health";
import { handleGitHubWebhook } from "./routes/webhooks";
import { runMigrations } from "../src/migrations";
import { runAnalyticsMigrations, setupAnalytics } from "../src/analytics";

let migrationsCompleted = false;

// Build the router
const router = new Router()
  // Auth routes
  .get("/auth/login", handleLogin)
  .get("/auth/callback", handleCallback)
  .get("/auth/me", handleMe)
  .add(["GET", "POST"], "/auth/logout", handleLogout)

  // API routes
  .get("/api/token", handleGetToken)
  .post("/api/token/rate-limit", handleRateLimitToken)
  .get("/api/stats", handleStats)
  .get("/api/migrations", handleMigrations)
  .get("/api/rate-limits", handleRateLimits)
  .get("/api/github/repo", handleGithubRepo)

  // Track routes (public)
  .post("/api/track", handleTrack)
  .get("/api/downloads", handleGetAllDownloads)
  .get("/api/downloads/30d", handleGet30DayDownloads)
  .get("/api/stats/mau", handleGetMAU)
  .post("/api/admin/aggregate", handleAggregate)
  .get(/^\/api\/downloads\/([^/]+)$/, (req, env, params) =>
    handleGetToolDownloads(req, env, params!["$1"])
  )

  // Health & webhooks
  .get("/health", (_, env) => handleHealth(env))
  .post("/webhooks/github", handleGitHubWebhook);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle OPTIONS preflight for all routes
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Run migrations once on first request
    if (!migrationsCompleted) {
      try {
        console.log("Running database migrations...");
        const db = getDb(env);
        await runMigrations(db);

        const analyticsDb = drizzle(env.ANALYTICS_DB);
        await runAnalyticsMigrations(analyticsDb);

        migrationsCompleted = true;
        console.log("Migrations completed");
      } catch (error) {
        console.error("Migration error:", error);
      }
    }

    try {
      // Try router first
      const response = await router.handle(request, env);
      if (response) return response;

      // Proxy /data/* to mise-versions.jdx.dev (GitHub Pages)
      if (path.startsWith("/data/")) {
        return handleDataProxy(request, path);
      }

      // Serve static assets with SPA fallback
      return handleStaticAssets(request, env, url);
    } catch (error) {
      console.error("Request error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
};

// Proxy /data/* to GitHub Pages with caching via Cache API
async function handleDataProxy(request: Request, path: string): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(new URL(path, request.url).toString());

  // Check cache first
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  // Fetch from origin
  const dataPath = path.slice(6); // Remove "/data/"
  const response = await fetch(`https://mise-versions.jdx.dev/${dataPath}`);

  const headers: Record<string, string> = {
    ...Object.fromEntries(response.headers),
    ...CORS_HEADERS,
  };

  // Only cache successful responses
  if (response.ok) {
    headers["Cache-Control"] = CACHE_CONTROL.STATIC;
    const cacheResponse = new Response(response.clone().body, {
      status: response.status,
      headers,
    });
    // Store in Cache API (non-blocking)
    await cache.put(cacheKey, cacheResponse);
  }

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

// Serve static assets with SPA fallback to index.html
async function handleStaticAssets(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const assetResponse = await env.ASSETS.fetch(request);
  if (assetResponse.status === 404) {
    const indexUrl = new URL("/", url);
    const indexResponse = await env.ASSETS.fetch(indexUrl.toString());
    return new Response(indexResponse.body, {
      status: 200,
      headers: indexResponse.headers,
    });
  }
  return assetResponse;
}

// Scheduled handler for daily aggregation
async function handleScheduled(env: Env): Promise<void> {
  console.log("Running scheduled aggregation...");

  const analyticsDb = drizzle(env.ANALYTICS_DB);
  const analytics = setupAnalytics(analyticsDb);

  const result = await analytics.aggregateOldData();
  console.log(
    `Aggregation complete: ${result.aggregated} groups aggregated, ${result.deleted} rows deleted`
  );
}
