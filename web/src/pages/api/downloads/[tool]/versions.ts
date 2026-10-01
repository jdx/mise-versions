import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupAnalytics } from "../../../../../../src/analytics";
import { env } from "cloudflare:workers";
import { requireSession } from "../../../../lib/session";
import {
  getCachedJson,
  putCachedJson,
  requestCacheKey,
} from "../../../../lib/kv-cache";

const VERSION_TRENDS_CACHE_TTL_SECONDS = 300;

export const GET: APIRoute = async ({ params, url, request, locals }) => {
  const session = await requireSession(request, env.API_SECRET);
  if (session instanceof Response) return session;

  try {
    const { tool } = params;
    if (!tool) {
      return new Response(JSON.stringify({ error: "Tool name required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const days = parseInt(url.searchParams.get("days") || "30", 10);
    const cacheKey = await requestCacheKey("download-versions", request);
    const cached = await getCachedJson(env.DOWNLOAD_DEDUPE, cacheKey);
    if (cached) {
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, no-store",
        },
      });
    }

    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const stats = await analytics.getVersionTrends(tool, days);
    locals.cfContext.waitUntil(
      putCachedJson(
        env.DOWNLOAD_DEDUPE,
        cacheKey,
        stats,
        VERSION_TRENDS_CACHE_TTL_SECONDS,
      ),
    );

    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    console.error("Get version trends error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to get version trends" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
