// Download statistics functions
import type { drizzle } from "drizzle-orm/d1";
import { sql, eq, and } from "drizzle-orm";
import {
  tools,
  platforms,
  downloads,
  downloadsDaily,
  dailyToolStats,
  dailyMauStats,
} from "./schema.js";

export function createStatsFunctions(db: ReturnType<typeof drizzle>) {
  return {
    // Get download stats for a specific tool
    async getDownloadStats(tool: string) {
      const toolRecord = await db
        .select({ id: tools.id })
        .from(tools)
        .where(eq(tools.name, tool))
        .get();

      if (!toolRecord) {
        return { total: 0, byVersion: [], byOs: [], daily: [] };
      }

      const toolId = toolRecord.id;

      // Total downloads (raw + aggregated)
      const rawTotal = await db
        .select({ count: sql<number>`count(*)` })
        .from(downloads)
        .where(eq(downloads.tool_id, toolId))
        .get();

      const aggTotal = await db
        .select({ count: sql<number>`coalesce(sum(count), 0)` })
        .from(downloadsDaily)
        .where(eq(downloadsDaily.tool_id, toolId))
        .get();

      const total = (rawTotal?.count ?? 0) + (aggTotal?.count ?? 0);

      // Downloads by version
      const byVersion = await db
        .select({
          version: downloads.version,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .where(eq(downloads.tool_id, toolId))
        .groupBy(downloads.version)
        .orderBy(sql`count(*) DESC`)
        .all();

      // Downloads by OS (join with platforms)
      const byOs = await db
        .select({
          os: platforms.os,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .leftJoin(platforms, eq(downloads.platform_id, platforms.id))
        .where(eq(downloads.tool_id, toolId))
        .groupBy(platforms.os)
        .all();

      // Daily downloads (last 30 days from rollups, excluding current day)
      const now = Math.floor(Date.now() / 1000);
      const today = new Date(now * 1000).toISOString().split("T")[0];
      const thirtyDaysAgo = new Date((now - 30 * 86400) * 1000)
        .toISOString()
        .split("T")[0];
      const daily = await db
        .select({
          date: dailyToolStats.date,
          count: dailyToolStats.downloads,
        })
        .from(dailyToolStats)
        .where(
          and(
            eq(dailyToolStats.tool_id, toolId),
            sql`${dailyToolStats.date} >= ${thirtyDaysAgo}`,
            sql`${dailyToolStats.date} < ${today}`,
          ),
        )
        .orderBy(dailyToolStats.date)
        .all();

      // Monthly downloads (last 12 months from rollups)
      const twelveMonthsAgo = new Date((now - 365 * 86400) * 1000)
        .toISOString()
        .split("T")[0];
      const monthly = await db
        .select({
          month: sql<string>`strftime('%Y-%m', ${dailyToolStats.date})`,
          count: sql<number>`sum(${dailyToolStats.downloads})`,
        })
        .from(dailyToolStats)
        .where(
          and(
            eq(dailyToolStats.tool_id, toolId),
            sql`${dailyToolStats.date} >= ${twelveMonthsAgo}`,
          ),
        )
        .groupBy(sql`strftime('%Y-%m', ${dailyToolStats.date})`)
        .orderBy(sql`strftime('%Y-%m', ${dailyToolStats.date})`)
        .all();

      return {
        total,
        byVersion,
        byOs,
        daily,
        monthly,
      };
    },

    // Get top downloaded tools (all time)
    async getTopTools(limit: number = 20) {
      const topTools = await db
        .select({
          name: tools.name,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .innerJoin(tools, eq(downloads.tool_id, tools.id))
        .groupBy(tools.name)
        .orderBy(sql`count(*) DESC`)
        .limit(limit)
        .all();

      const total = await db
        .select({ count: sql<number>`count(*)` })
        .from(downloads)
        .get();

      return {
        total: total?.count ?? 0,
        tools: topTools.map((t) => ({ tool: t.name, count: t.count })),
      };
    },

    // Get 30-day download counts for all tools
    // Uses daily_tool_stats rollup table for fast lookups
    async getAll30DayDownloads() {
      const now = Math.floor(Date.now() / 1000);
      const startDate = new Date((now - 30 * 86400) * 1000)
        .toISOString()
        .split("T")[0];

      // Sum downloads from rollup table (fast!)
      const results = await db
        .select({
          name: tools.name,
          count: sql<number>`sum(${dailyToolStats.downloads})`,
        })
        .from(dailyToolStats)
        .innerJoin(tools, eq(dailyToolStats.tool_id, tools.id))
        .where(sql`${dailyToolStats.date} >= ${startDate}`)
        .groupBy(tools.name)
        .all();

      const counts: Record<string, number> = {};
      for (const r of results) {
        counts[r.name] = r.count;
      }
      return counts;
    },

    // Get monthly active users from pre-computed rollup table
    async getMAU() {
      const today = new Date().toISOString().split("T")[0];
      const yesterday = new Date(Date.now() - 86400000)
        .toISOString()
        .split("T")[0];

      // Try today's value first, then yesterday's
      const result = await db
        .select({ mau: dailyMauStats.mau })
        .from(dailyMauStats)
        .where(sql`${dailyMauStats.date} IN (${today}, ${yesterday})`)
        .orderBy(sql`${dailyMauStats.date} DESC`)
        .limit(1)
        .get();

      return result?.mau ?? 0;
    },
  };
}
