// Trend and growth analysis functions
import type { drizzle } from "drizzle-orm/d1";
import { sql, eq, and } from "drizzle-orm";
import {
  tools,
  downloads,
  dailyToolStats,
  dailyCombinedStats,
  dailyMauStats,
  dailyVersionStats,
  versionRequests,
} from "./schema.js";

export function createTrendsFunctions(db: ReturnType<typeof drizzle>) {
  return {
    // Get DAU and rolling MAU history for the last N days
    async getDAUMAUHistory(days: number = 30) {
      const now = Math.floor(Date.now() / 1000);
      const today = new Date(now * 1000).toISOString().split("T")[0];
      const startDate = new Date((now - days * 86400) * 1000)
        .toISOString()
        .split("T")[0];

      const dauResults = await db
        .select({
          date: dailyCombinedStats.date,
          dau: dailyCombinedStats.unique_users,
        })
        .from(dailyCombinedStats)
        .where(
          and(
            sql`${dailyCombinedStats.date} >= ${startDate}`,
            sql`${dailyCombinedStats.date} < ${today}`,
          ),
        )
        .orderBy(dailyCombinedStats.date)
        .all();

      const mauResults = await db
        .select({
          date: dailyMauStats.date,
          mau: dailyMauStats.mau,
        })
        .from(dailyMauStats)
        .where(
          and(
            sql`${dailyMauStats.date} >= ${startDate}`,
            sql`${dailyMauStats.date} < ${today}`,
          ),
        )
        .orderBy(dailyMauStats.date)
        .all();

      const dauMap = new Map(dauResults.map((r) => [r.date, r.dau]));
      const mauMap = new Map(mauResults.map((r) => [r.date, r.mau]));

      const dailyData: Array<{ date: string; dau: number; mau: number }> = [];
      for (let i = days - 1; i >= 1; i--) {
        const dayTimestamp = now - i * 86400;
        const date = new Date(dayTimestamp * 1000).toISOString().split("T")[0];
        dailyData.push({
          date,
          dau: dauMap.get(date) ?? 0,
          mau: mauMap.get(date) ?? 0,
        });
      }

      const todayMau = await db
        .select({ mau: dailyMauStats.mau })
        .from(dailyMauStats)
        .where(sql`${dailyMauStats.date} = ${today}`)
        .get();

      const currentMAU =
        todayMau?.mau ??
        (dailyData.length > 0 ? dailyData[dailyData.length - 1].mau : 0);

      return {
        daily: dailyData,
        current_mau: currentMAU,
      };
    },

    // Get mise DAU/MAU (unique users making version requests)
    async getMiseDAUMAU(days: number = 30) {
      const now = Math.floor(Date.now() / 1000);
      const startDate = new Date((now - days * 86400) * 1000)
        .toISOString()
        .split("T")[0];

      const dauResults = await db
        .select({
          date: dailyVersionStats.date,
          dau: dailyVersionStats.unique_users,
        })
        .from(dailyVersionStats)
        .where(sql`${dailyVersionStats.date} >= ${startDate}`)
        .orderBy(dailyVersionStats.date)
        .all();

      const thirtyDaysAgo = now - 30 * 86400;
      const mauResult = await db
        .select({
          mau: sql<number>`count(distinct ip_hash)`,
        })
        .from(versionRequests)
        .where(sql`${versionRequests.created_at} >= ${thirtyDaysAgo}`)
        .get();

      const currentMAU = mauResult?.mau ?? 0;

      const dailyData: Array<{ date: string; dau: number }> = [];
      const dauMap = new Map(dauResults.map((r) => [r.date, r.dau]));

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

    // Get version trends for a specific tool
    async getVersionTrends(toolName: string, days: number = 30) {
      const toolRecord = await db
        .select({ id: tools.id })
        .from(tools)
        .where(eq(tools.name, toolName))
        .get();

      if (!toolRecord) {
        return { versions: [], timeline: [] };
      }

      const now = Math.floor(Date.now() / 1000);
      const startTimestamp = now - days * 86400;

      const versionData = await db
        .select({
          version: downloads.version,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .where(
          and(
            eq(downloads.tool_id, toolRecord.id),
            sql`${downloads.created_at} >= ${startTimestamp}`,
          ),
        )
        .groupBy(downloads.version)
        .orderBy(sql`count(*) DESC`)
        .all();

      const totalDownloads = versionData.reduce((sum, v) => sum + v.count, 0);

      const versions = versionData.slice(0, 20).map((v) => {
        const share = totalDownloads > 0 ? (v.count / totalDownloads) * 100 : 0;
        return {
          version: v.version,
          downloads: v.count,
          share,
          trend: "stable" as "growing" | "declining" | "stable",
        };
      });

      const dailyData = await db
        .select({
          date: sql<string>`date(${downloads.created_at}, 'unixepoch')`,
          version: downloads.version,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .where(
          and(
            eq(downloads.tool_id, toolRecord.id),
            sql`${downloads.created_at} >= ${startTimestamp}`,
          ),
        )
        .groupBy(
          sql`date(${downloads.created_at}, 'unixepoch')`,
          downloads.version,
        )
        .orderBy(sql`date(${downloads.created_at}, 'unixepoch')`)
        .all();

      const topVersions = versions.slice(0, 10).map((v) => v.version);
      const timeline: Array<{
        date: string;
        [version: string]: number | string;
      }> = [];
      const versionCounts = new Map<string, Map<string, number>>();

      for (const d of dailyData) {
        if (!versionCounts.has(d.date)) {
          versionCounts.set(d.date, new Map());
        }
        versionCounts.get(d.date)!.set(d.version, d.count);
      }

      for (let i = days - 1; i >= 1; i--) {
        const date = new Date((now - i * 86400) * 1000)
          .toISOString()
          .split("T")[0];
        const dayCounts = versionCounts.get(date) || new Map();

        const dayData: { date: string; [version: string]: number | string } = {
          date,
        };
        for (const version of topVersions) {
          dayData[version] = dayCounts.get(version) || 0;
        }
        timeline.push(dayData);
      }

      const firstWeekEnd = 7;
      const lastWeekStart = Math.max(days - 7, firstWeekEnd);

      for (const v of versions) {
        let firstWeekTotal = 0;
        let lastWeekTotal = 0;

        for (let i = 0; i < timeline.length; i++) {
          const count = (timeline[i][v.version] as number) || 0;
          if (i < firstWeekEnd) {
            firstWeekTotal += count;
          }
          if (i >= lastWeekStart) {
            lastWeekTotal += count;
          }
        }

        if (firstWeekTotal > 0 && lastWeekTotal > firstWeekTotal * 1.1) {
          v.trend = "growing";
        } else if (firstWeekTotal > 0 && lastWeekTotal < firstWeekTotal * 0.9) {
          v.trend = "declining";
        }
      }

      return { versions, timeline };
    },

    // Get growth for a specific tool
    async getToolGrowth(toolName: string) {
      const toolRecord = await db
        .select({ id: tools.id })
        .from(tools)
        .where(eq(tools.name, toolName))
        .get();

      if (!toolRecord) {
        return { wow: null, mom: null, sparkline: [] };
      }

      const now = Math.floor(Date.now() / 1000);
      const sevenDaysAgo = now - 7 * 86400;
      const fourteenDaysAgo = now - 14 * 86400;
      const thirtyDaysAgo = now - 30 * 86400;
      const sixtyDaysAgo = now - 60 * 86400;

      const thisWeekStart = new Date(sevenDaysAgo * 1000)
        .toISOString()
        .split("T")[0];
      const lastWeekStart = new Date(fourteenDaysAgo * 1000)
        .toISOString()
        .split("T")[0];
      const thisMonthStart = new Date(thirtyDaysAgo * 1000)
        .toISOString()
        .split("T")[0];
      const lastMonthStart = new Date(sixtyDaysAgo * 1000)
        .toISOString()
        .split("T")[0];

      const periods = await Promise.all([
        db
          .select({
            total: sql<number>`coalesce(sum(${dailyToolStats.downloads}), 0)`,
          })
          .from(dailyToolStats)
          .where(
            and(
              eq(dailyToolStats.tool_id, toolRecord.id),
              sql`${dailyToolStats.date} >= ${thisWeekStart}`,
            ),
          )
          .get(),
        db
          .select({
            total: sql<number>`coalesce(sum(${dailyToolStats.downloads}), 0)`,
          })
          .from(dailyToolStats)
          .where(
            and(
              eq(dailyToolStats.tool_id, toolRecord.id),
              sql`${dailyToolStats.date} >= ${lastWeekStart}`,
              sql`${dailyToolStats.date} < ${thisWeekStart}`,
            ),
          )
          .get(),
        db
          .select({
            total: sql<number>`coalesce(sum(${dailyToolStats.downloads}), 0)`,
          })
          .from(dailyToolStats)
          .where(
            and(
              eq(dailyToolStats.tool_id, toolRecord.id),
              sql`${dailyToolStats.date} >= ${thisMonthStart}`,
            ),
          )
          .get(),
        db
          .select({
            total: sql<number>`coalesce(sum(${dailyToolStats.downloads}), 0)`,
          })
          .from(dailyToolStats)
          .where(
            and(
              eq(dailyToolStats.tool_id, toolRecord.id),
              sql`${dailyToolStats.date} >= ${lastMonthStart}`,
              sql`${dailyToolStats.date} < ${thisMonthStart}`,
            ),
          )
          .get(),
      ]);

      const [thisWeek, lastWeek, thisMonth, lastMonth] = periods.map(
        (p) => p?.total ?? 0,
      );

      const wow =
        lastWeek > 0 ? ((thisWeek - lastWeek) / lastWeek) * 100 : null;
      const mom =
        lastMonth > 0 ? ((thisMonth - lastMonth) / lastMonth) * 100 : null;

      const sparklineStart = new Date((now - 14 * 86400) * 1000)
        .toISOString()
        .split("T")[0];
      const today = new Date(now * 1000).toISOString().split("T")[0];
      const sparklineData = await db
        .select({
          date: dailyToolStats.date,
          downloads: dailyToolStats.downloads,
        })
        .from(dailyToolStats)
        .where(
          and(
            eq(dailyToolStats.tool_id, toolRecord.id),
            sql`${dailyToolStats.date} >= ${sparklineStart}`,
            sql`${dailyToolStats.date} < ${today}`,
          ),
        )
        .orderBy(dailyToolStats.date)
        .all();

      const sparkline: number[] = [];
      const sparklineMap = new Map(
        sparklineData.map((d) => [d.date, d.downloads]),
      );
      for (let i = 13; i >= 1; i--) {
        const date = new Date((now - i * 86400) * 1000)
          .toISOString()
          .split("T")[0];
        sparkline.push(sparklineMap.get(date) ?? 0);
      }

      return {
        wow,
        mom,
        sparkline,
        thisWeek,
        lastWeek,
        thisMonth,
        lastMonth,
      };
    },

    // Get sparklines for multiple tools at once
    async getBatchSparklines(
      toolNames: string[],
    ): Promise<Record<string, number[]>> {
      if (toolNames.length === 0) return {};

      const now = Math.floor(Date.now() / 1000);
      const sparklineStart = new Date((now - 14 * 86400) * 1000)
        .toISOString()
        .split("T")[0];
      const today = new Date(now * 1000).toISOString().split("T")[0];

      const toolRecords = await db
        .select({ id: tools.id, name: tools.name })
        .from(tools)
        .where(
          sql`${tools.name} IN (${sql.join(
            toolNames.map((n) => sql`${n}`),
            sql`, `,
          )})`,
        )
        .all();

      if (toolRecords.length === 0) return {};

      const toolIdMap = new Map(toolRecords.map((t) => [t.id, t.name]));
      const toolIds = toolRecords.map((t) => t.id);

      const sparklineData = await db
        .select({
          tool_id: dailyToolStats.tool_id,
          date: dailyToolStats.date,
          downloads: dailyToolStats.downloads,
        })
        .from(dailyToolStats)
        .where(
          and(
            sql`${dailyToolStats.tool_id} IN (${sql.join(
              toolIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
            sql`${dailyToolStats.date} >= ${sparklineStart}`,
            sql`${dailyToolStats.date} < ${today}`,
          ),
        )
        .orderBy(dailyToolStats.date)
        .all();

      const dataByTool = new Map<number, Map<string, number>>();
      for (const d of sparklineData) {
        if (!dataByTool.has(d.tool_id)) {
          dataByTool.set(d.tool_id, new Map());
        }
        dataByTool.get(d.tool_id)!.set(d.date, d.downloads);
      }

      const result: Record<string, number[]> = {};
      for (const [toolId, toolName] of toolIdMap) {
        const dateMap = dataByTool.get(toolId) || new Map();
        const sparkline: number[] = [];
        for (let i = 13; i >= 1; i--) {
          const date = new Date((now - i * 86400) * 1000)
            .toISOString()
            .split("T")[0];
          sparkline.push(dateMap.get(date) ?? 0);
        }
        result[toolName] = sparkline;
      }

      return result;
    },

    // Get trending tools combining monthly popularity + daily momentum
    async getTrendingTools(limit: number = 6): Promise<
      Array<{
        name: string;
        downloads_30d: number;
        trendingScore: number;
        dailyBoost: number;
        sparkline: number[];
        description?: string;
        backends?: string[];
        security?: Array<{ type: string; algorithm?: string }>;
        version_count: number;
      }>
    > {
      const now = Math.floor(Date.now() / 1000);
      const thirtyDaysAgo = new Date((now - 30 * 86400) * 1000)
        .toISOString()
        .split("T")[0];
      const today = new Date(now * 1000).toISOString().split("T")[0];

      const dailyData = await db
        .select({
          tool_id: dailyToolStats.tool_id,
          name: tools.name,
          date: dailyToolStats.date,
          downloads: dailyToolStats.downloads,
        })
        .from(dailyToolStats)
        .innerJoin(tools, eq(dailyToolStats.tool_id, tools.id))
        .where(
          and(
            sql`${dailyToolStats.date} >= ${thirtyDaysAgo}`,
            sql`${dailyToolStats.date} < ${today}`,
          ),
        )
        .orderBy(dailyToolStats.date)
        .all();

      const toolData = new Map<
        string,
        { total: number; daily: Map<string, number> }
      >();
      for (const row of dailyData) {
        if (!toolData.has(row.name)) {
          toolData.set(row.name, { total: 0, daily: new Map() });
        }
        const data = toolData.get(row.name)!;
        data.total += row.downloads;
        data.daily.set(row.date, row.downloads);
      }

      if (toolData.size === 0) return [];

      const results: Array<{
        name: string;
        downloads_30d: number;
        trendingScore: number;
        dailyBoost: number;
        sparkline: number[];
        description?: string;
        backends?: string[];
        security?: Array<{ type: string; algorithm?: string }>;
        version_count: number;
      }> = [];

      for (const [name, data] of toolData) {
        const sparkline: number[] = [];
        for (let i = 13; i >= 1; i--) {
          const date = new Date((now - i * 86400) * 1000)
            .toISOString()
            .split("T")[0];
          sparkline.push(data.daily.get(date) ?? 0);
        }

        let recentSum = 0;
        let recentDays = 0;
        let baselineSum = 0;
        let baselineDays = 0;

        for (let i = 1; i <= 30; i++) {
          const date = new Date((now - i * 86400) * 1000)
            .toISOString()
            .split("T")[0];
          const downloads = data.daily.get(date) ?? 0;

          if (i <= 3) {
            recentSum += downloads;
            recentDays++;
          } else {
            baselineSum += downloads;
            baselineDays++;
          }
        }

        const recentAvg = recentDays > 0 ? recentSum / recentDays : 0;
        const baselineAvg = baselineDays > 0 ? baselineSum / baselineDays : 0;

        // Score based purely on recent momentum (ratio of last 3 days vs baseline)
        let dailyBoost = 0;
        if (baselineAvg > 0 && recentAvg > baselineAvg) {
          const ratio = recentAvg / baselineAvg;
          dailyBoost = (ratio - 1) * 100;
        }

        const trendingScore = dailyBoost;

        results.push({
          name,
          downloads_30d: data.total,
          trendingScore,
          dailyBoost,
          sparkline,
          version_count: 0,
        });
      }

      results.sort((a, b) => b.trendingScore - a.trendingScore);
      const topResults = results.slice(0, limit);

      // Fetch metadata for trending tools (description, backends, security, version_count)
      // These columns exist in the DB but aren't in the drizzle schema, so use raw SQL
      if (topResults.length > 0) {
        const names = topResults.map((t) => t.name);
        const metaRows = await db.all<{
          name: string;
          description: string | null;
          backends: string | null;
          security: string | null;
          version_count: number | null;
        }>(sql`
          SELECT name, description, backends, security, version_count
          FROM tools
          WHERE name IN (${sql.join(names.map((n) => sql`${n}`), sql`, `)})
        `);

        const metaMap = new Map(metaRows.map((r) => [r.name, r]));
        for (const result of topResults) {
          const meta = metaMap.get(result.name);
          if (meta) {
            result.description = meta.description || undefined;
            result.backends = meta.backends ? JSON.parse(meta.backends) : undefined;
            result.security = meta.security ? JSON.parse(meta.security) : undefined;
            result.version_count = meta.version_count || 0;
          }
        }
      }

      return topResults;
    },
  };
}
