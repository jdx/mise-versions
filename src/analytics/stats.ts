// Download statistics functions
import type { drizzle } from "drizzle-orm/d1";
import { sql, eq, and } from "drizzle-orm";
import {
  tools,
  platforms,
  dailyToolStats,
  dailyMauStats,
  toolDownloadSummaries,
  toolPlatformDownloadSummaries,
  toolVersionDownloadSummaries,
} from "./schema.js";

export function createStatsFunctions(db: ReturnType<typeof drizzle>) {
  async function getToolId(tool: string): Promise<number | null> {
    const toolRecord = await db
      .select({ id: tools.id })
      .from(tools)
      .where(eq(tools.name, tool))
      .get();
    return toolRecord?.id ?? null;
  }

  const analytics = {
    // The part of a tool's download stats that is public: the all-time total
    // and the last 30 days. Runs only the queries it returns.
    async getDownloadSummary(tool: string) {
      const toolId = await getToolId(tool);
      if (toolId === null) return { total: 0, daily: [] };

      const summary = await db
        .select({ count: toolDownloadSummaries.downloads_all_time })
        .from(toolDownloadSummaries)
        .where(eq(toolDownloadSummaries.tool_id, toolId))
        .get();

      const total = summary?.count ?? 0;

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

      return { total, daily };
    },

    // The breakdowns shown to signed-in visitors only: per version, per
    // platform and per month. Runs only the queries it returns.
    async getDownloadBreakdowns(tool: string) {
      const toolId = await getToolId(tool);
      if (toolId === null) return { byVersion: [], byOs: [], monthly: [] };

      // Downloads by version
      const byVersion = await db
        .select({
          version: toolVersionDownloadSummaries.version,
          count: toolVersionDownloadSummaries.downloads_all_time,
        })
        .from(toolVersionDownloadSummaries)
        .where(eq(toolVersionDownloadSummaries.tool_id, toolId))
        .orderBy(sql`${toolVersionDownloadSummaries.downloads_all_time} DESC`)
        .all();

      // Downloads by OS (join with platforms)
      const byOs = await db
        .select({
          os: platforms.os,
          count: sql<number>`sum(${toolPlatformDownloadSummaries.downloads_all_time})`,
        })
        .from(toolPlatformDownloadSummaries)
        .leftJoin(
          platforms,
          eq(toolPlatformDownloadSummaries.platform_id, platforms.id),
        )
        .where(eq(toolPlatformDownloadSummaries.tool_id, toolId))
        .groupBy(platforms.os)
        .all();

      const now = Math.floor(Date.now() / 1000);
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

      return { byVersion, byOs, monthly };
    },

    // Everything above in one call, for callers that want it all.
    async getDownloadStats(tool: string) {
      const [summary, breakdowns] = await Promise.all([
        analytics.getDownloadSummary(tool),
        analytics.getDownloadBreakdowns(tool),
      ]);
      return { ...summary, ...breakdowns };
    },

    // Get top downloaded tools (all time)
    async getTopTools(limit: number = 20) {
      const topTools = await db
        .select({
          name: tools.name,
          count: toolDownloadSummaries.downloads_all_time,
        })
        .from(toolDownloadSummaries)
        .innerJoin(tools, eq(toolDownloadSummaries.tool_id, tools.id))
        .where(sql`${toolDownloadSummaries.downloads_all_time} > 0`)
        .orderBy(sql`${toolDownloadSummaries.downloads_all_time} DESC`)
        .limit(limit)
        .all();

      const total = await db
        .select({
          count: sql<number>`coalesce(sum(${toolDownloadSummaries.downloads_all_time}), 0)`,
        })
        .from(toolDownloadSummaries)
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
      // Rollups only describe complete days, so skip the current UTC day: a row
      // for it would be a partial count left over from an older refresher. Fall
      // back to the latest populated date, since the scheduled MAU step can lag
      // behind other rollups and returning 0 hides the header badge even when
      // recent MAU data exists.
      const result = await db
        .select({ mau: dailyMauStats.mau, date: dailyMauStats.date })
        .from(dailyMauStats)
        .where(sql`${dailyMauStats.date} < ${today}`)
        .orderBy(sql`${dailyMauStats.date} DESC`)
        .limit(1)
        .get();

      return result?.mau ?? 0;
    },
  };

  return analytics;
}
