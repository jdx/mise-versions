import type { APIRoute } from "astro";
import { loadToolsPaginated } from "../../../lib/data-loader";
import {
  getCachedJson,
  putCachedJson,
  requestCacheKey,
} from "../../../lib/kv-cache";

const TOOLS_CACHE_TTL_SECONDS = 300;

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const runtime = locals.runtime;
    const cacheKey = await requestCacheKey("api-tools", url);
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

    // Parse query parameters
    const page = parseInt(url.searchParams.get("page") || "1", 10);
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const search = url.searchParams.get("q") || undefined;
    const sortParam = url.searchParams.get("sort");
    const sort =
      sortParam === "name" ||
      sortParam === "downloads" ||
      sortParam === "updated"
        ? sortParam
        : "downloads";
    const backendsParam = url.searchParams.get("backends");
    const backends = backendsParam
      ? backendsParam.split(",").filter(Boolean)
      : undefined;

    // Validate page and limit
    const validPage = Math.max(1, page);
    const validLimit = Math.min(100, Math.max(1, limit));

    const result = await loadToolsPaginated(runtime.env.ANALYTICS_DB, {
      page: validPage,
      limit: validLimit,
      search,
      sort,
      backends,
    });
    runtime.ctx.waitUntil(
      putCachedJson(
        runtime.env.DOWNLOAD_DEDUPE,
        cacheKey,
        result,
        TOOLS_CACHE_TTL_SECONDS,
      ),
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=600, stale-while-revalidate=3600",
      },
    });
  } catch (error) {
    console.error("Get paginated tools error:", error);
    return new Response(JSON.stringify({ error: "Failed to load tools" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
