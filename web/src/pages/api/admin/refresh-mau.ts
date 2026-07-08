import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import { setupAnalytics } from "../../../../../src/analytics";
import { jsonResponse, errorResponse } from "../../../lib/api";
import { requireBearerOrAdmin } from "../../../lib/admin";

function dateStrAgo(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().split("T")[0];
}

// POST /api/admin/refresh-mau - Refresh just the user-visible MAU rollups.
// This is intentionally narrow so admins can repair the stats page without
// running every maintenance task.
export const POST: APIRoute = async ({ request }) => {
  const auth = await requireBearerOrAdmin(request, env.API_SECRET);
  if (auth instanceof Response) return auth;

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

    const targets = [dateStrAgo(0), dateStrAgo(1)];
    const results: Array<{
      date: string;
      ok: boolean;
      refreshed?: boolean;
      error?: string;
    }> = [];
    for (const date of targets) {
      try {
        const refreshed = await analytics.populateDailyMauStats(
          date,
          env.ANALYTICS_DB,
        );
        results.push({
          date,
          ok: refreshed === true,
          refreshed,
          ...(refreshed === true ? {} : { error: "No MAU row was refreshed" }),
        });
      } catch (error) {
        results.push({
          date,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const failed = results.filter((r) => !r.ok);
    return jsonResponse({
      success: failed.length === 0,
      results,
      failed_count: failed.length,
    });
  } catch (error) {
    console.error("Refresh MAU error:", error);
    return errorResponse("Failed to refresh MAU", 500);
  }
};
