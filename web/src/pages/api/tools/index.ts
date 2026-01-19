import type { APIRoute } from "astro";
import { loadToolsPaginated } from "../../../lib/data-loader";

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const runtime = locals.runtime;

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

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
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
