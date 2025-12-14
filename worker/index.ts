// Cloudflare Worker entry point
import { drizzle } from "drizzle-orm/d1";
import { Env, CORS_HEADERS, jsonResponse, getDb } from "./shared";
import {
  handleLogin,
  handleCallback,
  handleMe,
  handleLogout,
} from "./routes/auth";
import {
  handleGetToken,
  handleRateLimitToken,
  handleStats,
  handleMigrations,
  handleRateLimits,
} from "./routes/api";
import {
  handleTrack,
  handleGetToolDownloads,
  handleGetAllDownloads,
  handleGet30DayDownloads,
  handleGetMAU,
} from "./routes/track";
import { setupDatabase } from "../src/database";
import { runMigrations, getMigrationStatus } from "../src/migrations";
import { runAnalyticsMigrations } from "../src/analytics";

let migrationsCompleted = false;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle OPTIONS preflight for all routes
    if (method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Run migrations once on first request
    if (!migrationsCompleted) {
      try {
        console.log("Running database migrations...");
        const db = getDb(env);
        await runMigrations(db);

        // Run analytics database migrations
        const analyticsDb = drizzle(env.ANALYTICS_DB);
        await runAnalyticsMigrations(analyticsDb);

        migrationsCompleted = true;
        console.log("Migrations completed");
      } catch (error) {
        console.error("Migration error:", error);
      }
    }

    // Route matching
    try {
      // Auth routes
      if (path === "/auth/login" && method === "GET") {
        return handleLogin(request, env);
      }
      if (path === "/auth/callback" && method === "GET") {
        return handleCallback(request, env);
      }
      if (path === "/auth/me" && method === "GET") {
        return handleMe(request, env);
      }
      if (path === "/auth/logout" && (method === "GET" || method === "POST")) {
        return handleLogout();
      }

      // API routes
      if (path === "/api/token" && method === "GET") {
        return handleGetToken(request, env);
      }
      if (path === "/api/token/rate-limit" && method === "POST") {
        return handleRateLimitToken(request, env);
      }
      if (path === "/api/stats" && method === "GET") {
        return handleStats(request, env);
      }
      if (path === "/api/migrations" && method === "GET") {
        return handleMigrations(request, env);
      }
      if (path === "/api/rate-limits" && method === "GET") {
        return handleRateLimits(request, env);
      }

      // Track routes (public, no auth required)
      if (path === "/api/track" && method === "POST") {
        return handleTrack(request, env);
      }
      if (path === "/api/downloads" && method === "GET") {
        return handleGetAllDownloads(request, env);
      }
      // 30-day download counts for all tools (must be before :tool pattern)
      if (path === "/api/downloads/30d" && method === "GET") {
        return handleGet30DayDownloads(request, env);
      }
      // Monthly active users
      if (path === "/api/stats/mau" && method === "GET") {
        return handleGetMAU(request, env);
      }
      // Match /api/downloads/:tool pattern
      const downloadMatch = path.match(/^\/api\/downloads\/([^/]+)$/);
      if (downloadMatch && method === "GET") {
        return handleGetToolDownloads(request, env, downloadMatch[1]);
      }

      // Health check
      if (path === "/health" && method === "GET") {
        return handleHealth(env);
      }

      // Webhooks
      if (path === "/webhooks/github" && method === "POST") {
        return handleGitHubWebhook(request);
      }

      // Proxy /data/* to mise-versions.jdx.dev (GitHub Pages)
      if (path.startsWith("/data/")) {
        const dataPath = path.slice(6); // Remove "/data/"
        const dataUrl = `https://mise-versions.jdx.dev/${dataPath}`;
        const response = await fetch(dataUrl);
        // Return with CORS headers
        return new Response(response.body, {
          status: response.status,
          headers: {
            ...Object.fromEntries(response.headers),
            ...CORS_HEADERS,
          },
        });
      }

      // Serve static assets, with SPA fallback to index.html
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status === 404) {
        // SPA fallback: serve index.html for client-side routing
        // Fetch "/" since assets binding redirects /index.html to /
        const indexUrl = new URL("/", url);
        const indexResponse = await env.ASSETS.fetch(indexUrl.toString());
        // Return with original URL so client-side router works
        return new Response(indexResponse.body, {
          status: 200,
          headers: indexResponse.headers,
        });
      }
      return assetResponse;
    } catch (error) {
      console.error("Request error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};

// GET /health - Health check with token statistics
async function handleHealth(env: Env): Promise<Response> {
  const db = getDb(env);
  const database = setupDatabase(db);

  const stats = await database.getTokenStats();
  const expiringTokens = await database.getExpiringTokens();
  const migrationStatus = await getMigrationStatus(db);

  return jsonResponse({
    status: "healthy",
    timestamp: new Date().toISOString(),
    tokens: stats,
    tokenTypes: {
      total: stats.total,
      active: stats.active,
    },
    expiringTokens: expiringTokens.length,
    migrations: migrationStatus,
  });
}

// POST /webhooks/github - GitHub webhooks handler
async function handleGitHubWebhook(request: Request): Promise<Response> {
  const payload = await request.text();
  const eventType = request.headers.get("x-github-event");

  console.log(`Webhook received: ${eventType} event`);

  return new Response("Webhook processed", {
    status: 200,
    headers: CORS_HEADERS,
  });
}
