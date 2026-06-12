import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import {
  getCachedVersionRows,
  getCachedText,
  loadVersionRows,
  putCachedVersionRows,
  putCachedText,
  versionsToText,
} from "../../lib/version-files";
import { logCostProbe, type CostProbe } from "../../lib/cost-observability";

// GET /tools/:tool - serves plain text version list from D1
// e.g., /tools/node returns one version per line
// Note: .gz files are handled by [tool].gz.ts
export const GET: APIRoute = async ({ request, params, locals }) => {
  const started = Date.now();
  const tool = params.tool;

  if (!tool) {
    return new Response("Tool name required", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Validate tool name (alphanumeric, hyphens, underscores, slashes)
  if (!/^[\w\-\/]+$/.test(tool)) {
    return new Response("Invalid tool name", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  try {
    const cached = await getCachedText(request, ":text");
    if (cached !== null) {
      logCostProbe({
        route: "tools/[...tool]",
        status: 200,
        duration_ms: Date.now() - started,
        cache: "edge",
        tracking: "none",
      });
      return new Response(cached, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=600",
        },
      });
    }

    const db = drizzle(env.ANALYTICS_DB);
    const options = { stableOnly: true };
    let cache: CostProbe["cache"] = "kv";
    let versions = await getCachedVersionRows(
      env.DOWNLOAD_DEDUPE,
      tool,
      options,
    );
    if (versions === null) {
      cache = "d1";
      versions = await loadVersionRows(db, tool, options);
      if (versions !== null) {
        locals.cfContext.waitUntil(
          putCachedVersionRows(env.DOWNLOAD_DEDUPE, tool, options, versions),
        );
      }
    }
    if (versions === null) {
      logCostProbe({
        route: "tools/[...tool]",
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

    const text = versionsToText(versions);
    locals.cfContext.waitUntil(
      putCachedText(request, ":text", text, "text/plain; charset=utf-8"),
    );

    logCostProbe({
      route: "tools/[...tool]",
      status: 200,
      duration_ms: Date.now() - started,
      cache,
      tracking: "none",
    });

    return new Response(text, {
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
