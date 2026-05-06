import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { jsonResponse, errorResponse } from "../../../../lib/api";
import { requireAdminAuth } from "../../../../lib/admin";

// GET /api/admin/maintenance/status - Health snapshot for the daily cron.
// Surfaces whether each rollup table is fresh and whether aggregateOldData
// is keeping the downloads table within its 90-day retention window.
export const GET: APIRoute = async ({ request }) => {
  const auth = await requireAdminAuth(request, env.API_SECRET);
  if (auth instanceof Response) return auth;

  try {
    const db = drizzle(env.ANALYTICS_DB);
    const ninetyDaysAgo = Math.floor(Date.now() / 1000) - 90 * 86400;

    const [mau, combined, version, dailyTool, downloadsAge, oldDownloads] =
      await Promise.all([
        db.get<{ max_date: string | null }>(
          sql`SELECT MAX(date) AS max_date FROM daily_mau_stats`,
        ),
        db.get<{ max_date: string | null }>(
          sql`SELECT MAX(date) AS max_date FROM daily_combined_stats`,
        ),
        db.get<{ max_date: string | null }>(
          sql`SELECT MAX(date) AS max_date FROM daily_version_stats`,
        ),
        db.get<{ max_date: string | null }>(
          sql`SELECT MAX(date) AS max_date FROM daily_tool_stats`,
        ),
        db.get<{ min_ts: number | null; max_ts: number | null }>(
          sql`SELECT MIN(created_at) AS min_ts, MAX(created_at) AS max_ts FROM downloads`,
        ),
        db.get<{ count: number }>(
          sql`SELECT COUNT(*) AS count FROM downloads WHERE created_at < ${ninetyDaysAgo}`,
        ),
      ]);

    return jsonResponse({
      cron_schedule: "0 1 * * *",
      rollups: {
        daily_mau_stats: mau?.max_date ?? null,
        daily_combined_stats: combined?.max_date ?? null,
        daily_version_stats: version?.max_date ?? null,
        daily_tool_stats: dailyTool?.max_date ?? null,
      },
      downloads: {
        oldest_ts: downloadsAge?.min_ts ?? null,
        oldest_iso: downloadsAge?.min_ts
          ? new Date(downloadsAge.min_ts * 1000).toISOString()
          : null,
        latest_ts: downloadsAge?.max_ts ?? null,
        latest_iso: downloadsAge?.max_ts
          ? new Date(downloadsAge.max_ts * 1000).toISOString()
          : null,
        rows_older_than_90d: oldDownloads?.count ?? 0,
      },
    });
  } catch (error) {
    console.error("Maintenance status error:", error);
    return errorResponse("Failed to fetch maintenance status", 500);
  }
};
