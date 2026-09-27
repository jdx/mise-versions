import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { jsonResponse, errorResponse } from "../../../../lib/api";
import { requireAdminAuth } from "../../../../lib/admin";

// GET /api/admin/maintenance/status - Health snapshot for GitHub Actions maintenance.
// Surfaces whether each rollup table is fresh.
export const GET: APIRoute = async ({ request }) => {
  const auth = await requireAdminAuth(request, env.API_SECRET);
  if (auth instanceof Response) return auth;

  try {
    const db = drizzle(env.ANALYTICS_DB);

    const [mau, combined, version, dailyTool] = await Promise.all([
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
    ]);

    return jsonResponse({
      rollups: {
        daily_mau_stats: mau?.max_date ?? null,
        daily_combined_stats: combined?.max_date ?? null,
        daily_version_stats: version?.max_date ?? null,
        daily_tool_stats: dailyTool?.max_date ?? null,
      },
    });
  } catch (error) {
    console.error("Maintenance status error:", error);
    return errorResponse("Failed to fetch maintenance status", 500);
  }
};
