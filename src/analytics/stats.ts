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
  toolDownloadSummaries,
  toolPlatformDownloadSummaries,
  toolVersionDownloadSummaries,
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

      const summary = await db
        .select({ count: toolDownloadSummaries.downloads_all_time })
        .from(toolDownloadSummaries)
        .where(eq(toolDownloadSummaries.tool_id, toolId))
        .get();

      let total = summary?.count ?? 0;
      if (!summary) {
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

        total = (rawTotal?.count ?? 0) + (aggTotal?.count ?? 0);
      }

      // Downloads by version
      let byVersion = await db
        .select({
          version: toolVersionDownloadSummaries.version,
          count: toolVersionDownloadSummaries.downloads_all_time,
        })
        .from(toolVersionDownloadSummaries)
        .where(eq(toolVersionDownloadSummaries.tool_id, toolId))
        .orderBy(sql`${toolVersionDownloadSummaries.downloads_all_time} DESC`)
        .all();

      if (byVersion.length === 0 && total > 0) {
        byVersion = await db.all<{
          version: string;
          count: number;
        }>(sql`
          SELECT version, SUM(downloads) AS count
          FROM (
            SELECT version, COUNT(*) AS downloads
            FROM downloads
            WHERE tool_id = ${toolId}
            GROUP BY version
            UNION ALL
            SELECT version, SUM(count) AS downloads
            FROM downloads_daily
            WHERE tool_id = ${toolId}
            GROUP BY version
          )
          GROUP BY version
          ORDER BY count DESC
        `);
      }

      // Downloads by OS (join with platforms)
      let byOs = await db
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

      if (byOs.length === 0 && total > 0) {
        byOs = await db.all<{
          os: string | null;
          count: number;
        }>(sql`
          SELECT p.os, SUM(d.downloads) AS count
          FROM (
            SELECT platform_id, COUNT(*) AS downloads
            FROM downloads
            WHERE tool_id = ${toolId}
            GROUP BY platform_id
            UNION ALL
            SELECT platform_id, SUM(count) AS downloads
            FROM downloads_daily
            WHERE tool_id = ${toolId}
            GROUP BY platform_id
          ) d
          LEFT JOIN platforms p ON d.platform_id = p.id
          GROUP BY p.os
        `);
      }

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
      let topTools = await db
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

      let total = await db
        .select({
          count: sql<number>`coalesce(sum(${toolDownloadSummaries.downloads_all_time}), 0)`,
        })
        .from(toolDownloadSummaries)
        .get();

      if (topTools.length === 0 && (total?.count ?? 0) === 0) {
        topTools = await db.all<{
          name: string;
          count: number;
        }>(sql`
          SELECT t.name, SUM(d.downloads) AS count
          FROM (
            SELECT tool_id, COUNT(*) AS downloads
            FROM downloads
            GROUP BY tool_id
            UNION ALL
            SELECT tool_id, SUM(count) AS downloads
            FROM downloads_daily
            GROUP BY tool_id
          ) d
          INNER JOIN tools t ON d.tool_id = t.id
          GROUP BY t.name
          ORDER BY count DESC
          LIMIT ${limit}
        `);

        total = await db.get<{ count: number }>(sql`
          SELECT COALESCE(SUM(downloads), 0) AS count
          FROM (
            SELECT COUNT(*) AS downloads
            FROM downloads
            UNION ALL
            SELECT SUM(count) AS downloads
            FROM downloads_daily
          )
        `);
      }

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
