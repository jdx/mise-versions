// Cloudflare Worker entry point
import { drizzle } from "drizzle-orm/d1";
import { Env, CORS_HEADERS, jsonResponse, getDb, CACHE_CONTROL } from "./shared";
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
import { setupDatabase } from "../src/database";
import { runMigrations, getMigrationStatus } from "../src/migrations";
import { runAnalyticsMigrations, setupAnalytics } from "../src/analytics";

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
      if (path === "/api/github/repo" && method === "GET") {
        return handleGithubRepo(request, env);
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
      // Admin: aggregate old data
      if (path === "/api/admin/aggregate" && method === "POST") {
        return handleAggregate(request, env);
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
        return handleGitHubWebhook(request, env);
      }

      // Proxy /data/* to mise-versions.jdx.dev (GitHub Pages)
      if (path.startsWith("/data/")) {
        const dataPath = path.slice(6); // Remove "/data/"
        const dataUrl = `https://mise-versions.jdx.dev/${dataPath}`;
        const response = await fetch(dataUrl);
        // Return with CORS headers, only cache successful responses
        const headers: Record<string, string> = {
          ...Object.fromEntries(response.headers),
          ...CORS_HEADERS,
        };
        if (response.ok) {
          headers["Cache-Control"] = CACHE_CONTROL.STATIC;
        }
        return new Response(response.body, {
          status: response.status,
          headers,
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

  // Cron trigger for daily aggregation
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
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

// Verify GitHub webhook signature
async function verifyWebhookSignature(
  payload: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature || !signature.startsWith("sha256=")) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const expectedSig =
    "sha256=" +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  // Constant-time comparison
  if (signature.length !== expectedSig.length) return false;
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  return result === 0;
}

// POST /webhooks/github - GitHub webhooks handler
// Purges cache for updated tool version files
async function handleGitHubWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const payload = await request.text();
  const eventType = request.headers.get("x-github-event");
  const signature = request.headers.get("x-hub-signature-256");

  // Verify webhook signature
  if (!(await verifyWebhookSignature(payload, signature, env.GITHUB_WEBHOOK_SECRET))) {
    console.error("Invalid webhook signature");
    return new Response("Invalid signature", { status: 401 });
  }

  console.log(`Webhook received: ${eventType} event`);

  // Only process push events
  if (eventType !== "push") {
    return new Response("Webhook processed", {
      status: 200,
      headers: CORS_HEADERS,
    });
  }

  try {
    const data = JSON.parse(payload) as {
      commits?: Array<{
        added?: string[];
        modified?: string[];
        removed?: string[];
      }>;
    };

    // Collect all modified files from all commits
    const modifiedFiles = new Set<string>();
    for (const commit of data.commits || []) {
      for (const file of commit.added || []) modifiedFiles.add(file);
      for (const file of commit.modified || []) modifiedFiles.add(file);
      for (const file of commit.removed || []) modifiedFiles.add(file);
    }

    // Filter to docs/ files (tool version files) and purge their cache
    const cache = caches.default;
    const baseUrl = new URL(request.url).origin;
    let purged = 0;

    for (const file of modifiedFiles) {
      // docs/node -> /data/node, docs/python/versions.txt -> /data/python/versions.txt
      if (file.startsWith("docs/")) {
        const dataPath = file.slice(5); // Remove "docs/"
        const cacheUrl = `${baseUrl}/data/${dataPath}`;
        const deleted = await cache.delete(new Request(cacheUrl));
        if (deleted) {
          console.log(`Purged cache: ${cacheUrl}`);
          purged++;
        }
      }
    }

    console.log(`Cache purge complete: ${purged} URLs purged`);

    return new Response(JSON.stringify({ purged, files: modifiedFiles.size }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return new Response("Webhook processed with errors", {
      status: 200,
      headers: CORS_HEADERS,
    });
  }
}

// Scheduled handler for daily aggregation (runs at midnight UTC)
async function handleScheduled(env: Env): Promise<void> {
  console.log("Running scheduled aggregation...");

  const analyticsDb = drizzle(env.ANALYTICS_DB);
  const analytics = setupAnalytics(analyticsDb);

  const result = await analytics.aggregateOldData();
  console.log(
    `Aggregation complete: ${result.aggregated} groups aggregated, ${result.deleted} rows deleted`
  );
}
