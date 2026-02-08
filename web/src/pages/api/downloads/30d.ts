import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupAnalytics } from "../../../../../src/analytics";

export const GET: APIRoute = async ({ locals }) => {
  try {
    const runtime = locals.runtime;
    const db = drizzle(runtime.env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const counts = await analytics.getAll30DayDownloads();

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
