// Version tracking and DAU/MAU functions
import type { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import type { AnalyticsEngineSqlConfig } from "./analytics-engine.js";

interface VersionsOptions {
  analyticsEngine?: AnalyticsEngineSqlConfig;
}

export function createVersionsFunctions(
  db: ReturnType<typeof drizzle>,
  _options: VersionsOptions = {},
) {
  return {
    // Record version updates (called when syncing new versions)
    async recordVersionUpdates(
      toolId: number,
      versionsAdded: number,
    ): Promise<void> {
      const today = new Date().toISOString().split("T")[0];

      // Upsert: add to existing count for today or insert new
      await db.run(sql`
        INSERT INTO version_updates (date, tool_id, versions_added)
        VALUES (${today}, ${toolId}, ${versionsAdded})
        ON CONFLICT(date, tool_id) DO UPDATE SET
          versions_added = version_updates.versions_added + excluded.versions_added
      `);
    },

    // Get version updates data for stats page (last 30 days)
    // Returns # of tools updated per day (not # of versions)
    async getVersionUpdates(days: number = 30): Promise<{
      daily: Array<{ date: string; count: number }>;
      total_updates: number;
      unique_tools: number;
      avg_per_day: number;
      days: number;
    }> {
      const now = new Date();
      const startDate = new Date(now);
      startDate.setDate(startDate.getDate() - days);
      const startDateStr = startDate.toISOString().split("T")[0];

      try {
        // Get daily counts (# of tools updated per day)
        const dailyResults = await db.all<{ date: string; count: number }>(sql`
          SELECT date, COUNT(DISTINCT tool_id) as count
          FROM version_updates
          WHERE date >= ${startDateStr}
          GROUP BY date
          ORDER BY date ASC
        `);

        // Get totals (total tool-days with updates, unique tools overall)
        const totals = await db.get<{
          total: number;
          unique_tools: number;
        }>(sql`
          SELECT
            COUNT(*) as total,
            COUNT(DISTINCT tool_id) as unique_tools
          FROM version_updates
          WHERE date >= ${startDateStr}
        `);

        // Fill in missing days with 0
        const dailyMap = new Map(dailyResults.map((r) => [r.date, r.count]));
        const daily: Array<{ date: string; count: number }> = [];

        for (let i = 0; i < days; i++) {
          const date = new Date(startDate);
          date.setDate(date.getDate() + i);
          const dateStr = date.toISOString().split("T")[0];
          daily.push({
            date: dateStr,
            count: dailyMap.get(dateStr) ?? 0,
          });
        }

        const totalUpdates = totals?.total ?? 0;
        const uniqueTools = totals?.unique_tools ?? 0;
        const avgPerDay = days > 0 ? totalUpdates / days : 0;

        return {
          daily,
          total_updates: totalUpdates,
          unique_tools: uniqueTools,
          avg_per_day: Math.round(avgPerDay * 10) / 10,
          days,
        };
      } catch (e) {
        // Table might not exist yet - return empty data
        console.error(
          "Failed to get version updates (table may not exist):",
          e,
        );
        return {
          daily: [],
          total_updates: 0,
          unique_tools: 0,
          avg_per_day: 0,
          days,
        };
      }
    },
  };
}
