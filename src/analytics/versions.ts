// Version tracking and DAU/MAU functions
import type { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { versionRequests, dailyVersionStats } from "./schema.js";

export function createVersionsFunctions(db: ReturnType<typeof drizzle>) {
  return {
    // Get mise DAU/MAU (unique users making version requests)
    async getMiseDAUMAU(days: number = 30) {
      const now = Math.floor(Date.now() / 1000);
      const startDate = new Date((now - days * 86400) * 1000).toISOString().split("T")[0];

      // Get DAU from rollup table
      const dauResults = await db
        .select({
          date: dailyVersionStats.date,
          dau: dailyVersionStats.unique_users,
        })
        .from(dailyVersionStats)
        .where(sql`${dailyVersionStats.date} >= ${startDate}`)
        .orderBy(dailyVersionStats.date)
        .all();

      // Get current MAU (30-day unique users)
      const thirtyDaysAgo = now - 30 * 86400;
      const mauResult = await db
        .select({
          mau: sql<number>`count(distinct ip_hash)`,
        })
        .from(versionRequests)
        .where(sql`${versionRequests.created_at} >= ${thirtyDaysAgo}`)
        .get();

      const currentMAU = mauResult?.mau ?? 0;

      // Fill in missing days with 0 (exclude current day since it's incomplete)
      const dailyData: Array<{ date: string; dau: number }> = [];
      const dauMap = new Map(dauResults.map(r => [r.date, r.dau]));

      for (let i = days - 1; i >= 1; i--) {
        const dayTimestamp = now - i * 86400;
        const date = new Date(dayTimestamp * 1000).toISOString().split("T")[0];
        dailyData.push({
          date,
          dau: dauMap.get(date) ?? 0,
        });
      }

      return {
        daily: dailyData,
        current_mau: currentMAU,
      };
    },

    // Record version updates (called when syncing new versions)
    async recordVersionUpdates(toolId: number, versionsAdded: number): Promise<void> {
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
        // Get daily counts
        const dailyResults = await db.all<{ date: string; count: number }>(sql`
          SELECT date, SUM(versions_added) as count
          FROM version_updates
          WHERE date >= ${startDateStr}
          GROUP BY date
          ORDER BY date ASC
        `);

        // Get totals
        const totals = await db.get<{ total: number; unique_tools: number }>(sql`
          SELECT
            SUM(versions_added) as total,
            COUNT(DISTINCT tool_id) as unique_tools
          FROM version_updates
          WHERE date >= ${startDateStr}
        `);

        // Fill in missing days with 0
        const dailyMap = new Map(dailyResults.map(r => [r.date, r.count]));
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
        console.error('Failed to get version updates (table may not exist):', e);
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
