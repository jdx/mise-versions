// Cloudflare Worker entry point
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
import { setupDatabase } from "../src/database";
import { runMigrations, getMigrationStatus } from "../src/migrations";

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

      // Serve static assets for all other routes
      return env.ASSETS.fetch(request);
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
