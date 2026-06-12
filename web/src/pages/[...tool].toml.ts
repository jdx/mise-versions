import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { hashIP, getClientIP } from "../lib/hash";
import { setupAnalytics } from "../../../src/analytics";
import { env } from "cloudflare:workers";
import {
  getCachedVersionRows,
  getCachedText,
  loadVersionRows,
  putCachedVersionRows,
  putCachedText,
  versionsToToml,
} from "../lib/version-files";
import { logCostProbe, type CostProbe } from "../lib/cost-observability";
import { analyticsEventsBinding } from "../lib/analytics-events";

// Legacy endpoint: GET /:tool.toml - serves TOML version file from D1
// e.g., /node.toml returns TOML with version metadata
export const GET: APIRoute = async ({ request, params, locals }) => {
  const started = Date.now();
  const tool = params.tool;

  if (!tool) {
    return new Response("Tool name required", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Validate tool name (alphanumeric, hyphens, underscores, slashes for namespaced tools)
  if (!/^[\w\-\/]+$/.test(tool)) {
    return new Response("Invalid tool name", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  try {
    const db = drizzle(env.ANALYTICS_DB);

    let toml = await getCachedText(request, ":toml");
    let cache: CostProbe["cache"] = "edge";
    if (toml === null) {
      cache = "kv";
      let versions = await getCachedVersionRows(env.DOWNLOAD_DEDUPE, tool);
      if (versions === null) {
        cache = "d1";
        versions = await loadVersionRows(db, tool);
        if (versions !== null) {
          locals.cfContext.waitUntil(
            putCachedVersionRows(env.DOWNLOAD_DEDUPE, tool, {}, versions),
          );
        }
      }
      if (versions === null) {
        logCostProbe({
          route: "[...tool].toml",
          status: 404,
          duration_ms: Date.now() - started,
          cache,
          tracking: "none",
        });
        return new Response(`Tool "${tool}" not found`, {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        });
      }
      toml = versionsToToml(versions);
      locals.cfContext.waitUntil(
        putCachedText(request, ":toml", toml, "text/plain; charset=utf-8"),
      );
    }

    // Track version request for DAU/MAU using waitUntil to ensure it completes.
    // Skip database storage for CI requests (excludes from MAU calculations).
    const isCI = request.headers.get("x-mise-ci") === "true";
    if (!isCI) {
      const clientIP = getClientIP(request);
      locals.cfContext.waitUntil(
        hashIP(clientIP, env.API_SECRET).then(async (ipHash) => {
          try {
            const analytics = setupAnalytics(db, {
              trackingCache: env.DOWNLOAD_DEDUPE,
              analyticsEvents: analyticsEventsBinding(),
            });
            await analytics.trackVersionRequest(ipHash);
          } catch (e) {
            console.error("Failed to track version request:", e);
          }
        }),
      );
    }

    logCostProbe({
      route: "[...tool].toml",
      status: 200,
      duration_ms: Date.now() - started,
      cache,
      tracking: isCI ? "ci_skipped" : "queued",
    });

    return new Response(toml, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=600",
      },
    });
  } catch (error) {
    console.error("Error fetching versions from D1:", error);
    return new Response("Failed to fetch tool data", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
};
