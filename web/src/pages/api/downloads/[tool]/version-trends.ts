import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupAnalytics } from "../../../../../../src/analytics";
import {
  getCachedJson,
  putCachedJson,
  requestCacheKey,
} from "../../../../lib/kv-cache";

const VERSION_TRENDS_CACHE_TTL_SECONDS = 300;

export const GET: APIRoute = async ({ params, request, locals }) => {
  const { tool } = params;

  if (!tool) {
    return new Response(JSON.stringify({ error: "Tool parameter required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get("days") || "30", 10);

  try {
    const runtime = locals.runtime;
    const cacheKey = await requestCacheKey("version-trends", request);
    const cached = await getCachedJson(runtime.env.DOWNLOAD_DEDUPE, cacheKey);
    if (cached) {
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
        },
      });
    }

    const db = drizzle(runtime.env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const data = await analytics.getVersionTrends(tool, days);
    runtime.ctx.waitUntil(
      putCachedJson(
        runtime.env.DOWNLOAD_DEDUPE,
        cacheKey,
        data,
        VERSION_TRENDS_CACHE_TTL_SECONDS,
      ),
    );

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      },
    });
  } catch (e) {
    console.error("Failed to get version trends:", e);
    return new Response(
      JSON.stringify({ error: "Failed to get version trends" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
