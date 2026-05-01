import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupAnalytics } from "../../../../../src/analytics";
import {
  getCachedJson,
  putCachedJson,
  requestCacheKey,
} from "../../../lib/kv-cache";

const DOWNLOADS_CACHE_TTL_SECONDS = 300;

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const runtime = locals.runtime;
    const cacheKey = await requestCacheKey("downloads-30d", request);
    const cached = await getCachedJson<Record<string, number>>(
      runtime.env.DOWNLOAD_DEDUPE,
      cacheKey,
    );
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

    const counts = await analytics.getAll30DayDownloads();
    runtime.ctx.waitUntil(
      putCachedJson(
        runtime.env.DOWNLOAD_DEDUPE,
        cacheKey,
        counts,
        DOWNLOADS_CACHE_TTL_SECONDS,
      ),
    );

    return new Response(JSON.stringify(counts), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      },
    });
  } catch (error) {
    console.error("Get 30-day downloads error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to get download stats" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
