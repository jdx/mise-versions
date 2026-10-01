import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupAnalytics } from "../../../../../src/analytics";

import { env } from "cloudflare:workers";
export const GET: APIRoute = async ({ params, locals }) => {
  try {
    const { tool } = params;
    if (!tool) {
      return new Response(JSON.stringify({ error: "Tool name required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    // Per-version, per-platform and 12-month breakdowns need a signed-in
    // session; see /api/downloads/<tool>/details.
    const { total, daily } = await analytics.getDownloadSummary(tool);

    return new Response(JSON.stringify({ total, daily }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      },
    });
  } catch (error) {
    console.error("Get tool downloads error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to get download stats" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
