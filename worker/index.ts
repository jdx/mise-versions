// Cloudflare Worker entry point
import { Env } from "./shared";
import { Router } from "./router";
import { ensureMigrations, handleScheduled } from "./scheduled";
import { handleStaticAssets, handleDataProxy } from "./proxy";

// Auth routes
import {
  handleLogin,
  handleCallback,
  handleMe,
  handleLogout,
} from "./routes/auth";

// API routes
import {
  handleGetToken,
  handleRateLimitToken,
  handleStats,
  handleMigrations,
  handleRateLimits,
  handleGithubRepo,
} from "./routes/api";

// Track routes
import {
  handleTrack,
  handleGetToolDownloads,
  handleGetAllDownloads,
  handleGet30DayDownloads,
  handleGetMAU,
  handleAggregate,
  handleGetBackendStats,
  handleGetDAUMAU,
  handleBackfillBackends,
  handleFinalizeBackends,
  handleBackfillRollups,
  handleGetGrowth,
  handleGetToolGrowth,
  handleGetVersionTrends,
} from "./routes/track";

// Misc routes
import { handleHealth, handleGitHubWebhook } from "./routes/misc";

// OG image routes
import { handleOgImage, handleOgImageHome } from "./routes/og";

// Badge routes
import {
  handleBadgeTotal,
  handleBadge30d,
  handleBadgeWeek,
} from "./routes/badge";

// Build router with all routes
function createRouter(): Router {
  const router = new Router();

  // Auth routes
  router.get("/auth/login", (req, env) => handleLogin(req, env));
  router.get("/auth/callback", (req, env) => handleCallback(req, env));
  router.get("/auth/me", (req, env) => handleMe(req, env));
  router.on(["GET", "POST"], "/auth/logout", () => handleLogout());

  // API routes
  router.get("/api/token", (req, env) => handleGetToken(req, env));
  router.post("/api/token/rate-limit", (req, env) => handleRateLimitToken(req, env));
  router.get("/api/stats", (req, env) => handleStats(req, env));
  router.get("/api/migrations", (req, env) => handleMigrations(req, env));
  router.get("/api/rate-limits", (req, env) => handleRateLimits(req, env));
  router.get("/api/github/repo", (req, env) => handleGithubRepo(req, env));

  // Track routes (public, no auth required)
  router.post("/api/track", (req, env) => handleTrack(req, env));
  router.get("/api/downloads", (req, env) => handleGetAllDownloads(req, env));
  router.get("/api/downloads/30d", (req, env) => handleGet30DayDownloads(req, env));
  router.get("/api/stats/mau", (req, env) => handleGetMAU(req, env));
  router.get("/api/stats/backends", (req, env) => handleGetBackendStats(req, env));
  router.get("/api/stats/dau-mau", (req, env) => handleGetDAUMAU(req, env));
  router.get("/api/stats/growth", (req, env) => handleGetGrowth(req, env));
  router.post("/api/admin/aggregate", (req, env) => handleAggregate(req, env));
  router.post("/api/admin/backfill-backends", (req, env) => handleBackfillBackends(req, env));
  router.post("/api/admin/finalize-backends", (req, env) => handleFinalizeBackends(req, env));
  router.post("/api/admin/backfill-rollups", (req, env) => handleBackfillRollups(req, env));
  router.get("/api/downloads/:tool/growth", (req, env, params) =>
    handleGetToolGrowth(req, env, params.tool)
  );
  router.get("/api/downloads/:tool/versions", (req, env, params) =>
    handleGetVersionTrends(req, env, params.tool)
  );
  router.get("/api/downloads/:tool", (req, env, params) =>
    handleGetToolDownloads(req, env, params.tool)
  );

  // Health check
  router.get("/health", (req, env) => handleHealth(req, env));

  // Webhooks
  router.post("/webhooks/github", (req) => handleGitHubWebhook(req));

  // OG image routes
  router.get("/api/og", (req, env) => handleOgImageHome(req, env));
  router.get("/api/og/:tool", (req, env, params) => handleOgImage(req, env, params.tool));

  // Badge routes (public)
  router.get("/badge/:tool", (req, env, params) => {
    // Handle .svg suffix
    const tool = params.tool.replace(/\.svg$/, "");
    return handleBadgeTotal(req, env, tool);
  });
  router.get("/badge/:tool/30d", (req, env, params) => handleBadge30d(req, env, params.tool));
  router.get("/badge/:tool/week", (req, env, params) => handleBadgeWeek(req, env, params.tool));

  // Data proxy (must be after specific routes)
  router.get("/data/*", handleDataProxy);

  return router;
}

const router = createRouter();

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Run migrations once on first request
    await ensureMigrations(env);

    try {
      // Try router first
      const response = await router.handle(request, env);
      if (response) {
        return response;
      }

      // Fall back to static assets with SPA support
      return handleStaticAssets(request, env);
    } catch (error) {
      console.error("Request error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },

  // Cron trigger for daily aggregation
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
};
