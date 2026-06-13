import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupAnalytics } from "../../../../../src/analytics";

import { env } from "cloudflare:workers";
export const GET: APIRoute = async ({ locals }) => {
  try {
    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db, {
      analyticsEngine: {
        accountId: env.ANALYTICS_ENGINE_ACCOUNT_ID,
        apiToken: env.ANALYTICS_ENGINE_API_TOKEN,
        dataset: env.ANALYTICS_ENGINE_DATASET,
        cutoverDate: env.ANALYTICS_ENGINE_CUTOVER_DATE,
      },
    });

    const stats = await analytics.getDAUMAUHistory(30);

    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
      },
    });
  } catch (error) {
    console.error("Get DAU/MAU error:", error);
    return new Response(
      JSON.stringify({ error: "Failed to get DAU/MAU stats" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
};
