// Growth metrics functions
import type { drizzle } from "drizzle-orm/d1";
import { sql, and } from "drizzle-orm";
import { tools, dailyStats, dailyToolStats } from "./schema.js";

export function createGrowthFunctions(db: ReturnType<typeof drizzle>) {
  return {
    // Get growth metrics (week-over-week and month-over-month)
    async getGrowthMetrics() {
      const now = Math.floor(Date.now() / 1000);

      // Calculate timestamps for each period
      const sevenDaysAgo = now - 7 * 86400;
      const fourteenDaysAgo = now - 14 * 86400;
      const thirtyDaysAgo = now - 30 * 86400;
      const sixtyDaysAgo = now - 60 * 86400;

      // Get downloads for each period from rollup tables
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

      // Global stats for this week
      const thisWeekGlobal = await db
        .select({
          total: sql<number>`coalesce(sum(${dailyStats.total_downloads}), 0)`,
        })
        .from(dailyStats)
        .where(sql`${dailyStats.date} >= ${thisWeekStart}`)
        .get();

      // Global stats for last week
      const lastWeekGlobal = await db
        .select({
          total: sql<number>`coalesce(sum(${dailyStats.total_downloads}), 0)`,
        })
        .from(dailyStats)
        .where(
          and(
            sql`${dailyStats.date} >= ${lastWeekStart}`,
            sql`${dailyStats.date} < ${thisWeekStart}`,
          ),
        )
        .get();

      // Global stats for this month
      const thisMonthGlobal = await db
        .select({
          total: sql<number>`coalesce(sum(${dailyStats.total_downloads}), 0)`,
        })
        .from(dailyStats)
        .where(sql`${dailyStats.date} >= ${thisMonthStart}`)
        .get();

      // Global stats for last month
      const lastMonthGlobal = await db
        .select({
          total: sql<number>`coalesce(sum(${dailyStats.total_downloads}), 0)`,
        })
        .from(dailyStats)
        .where(
          and(
            sql`${dailyStats.date} >= ${lastMonthStart}`,
            sql`${dailyStats.date} < ${thisMonthStart}`,
          ),
        )
        .get();

      // Calculate global growth rates
      const thisWeekTotal = thisWeekGlobal?.total ?? 0;
      const lastWeekTotal = lastWeekGlobal?.total ?? 0;
      const thisMonthTotal = thisMonthGlobal?.total ?? 0;
      const lastMonthTotal = lastMonthGlobal?.total ?? 0;

      const wowGrowth =
        lastWeekTotal > 0
          ? ((thisWeekTotal - lastWeekTotal) / lastWeekTotal) * 100
          : null;
      const momGrowth =
        lastMonthTotal > 0
          ? ((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100
          : null;

      // Get per-tool growth for this week vs last week
      const thisWeekByTool = await db
        .select({
          tool_id: dailyToolStats.tool_id,
          downloads: sql<number>`coalesce(sum(${dailyToolStats.downloads}), 0)`,
        })
        .from(dailyToolStats)
        .where(sql`${dailyToolStats.date} >= ${thisWeekStart}`)
        .groupBy(dailyToolStats.tool_id)
        .all();

      const lastWeekByTool = await db
        .select({
          tool_id: dailyToolStats.tool_id,
          downloads: sql<number>`coalesce(sum(${dailyToolStats.downloads}), 0)`,
        })
        .from(dailyToolStats)
        .where(
          and(
            sql`${dailyToolStats.date} >= ${lastWeekStart}`,
            sql`${dailyToolStats.date} < ${thisWeekStart}`,
          ),
        )
        .groupBy(dailyToolStats.tool_id)
        .all();

      // Build tool growth map
      const thisWeekMap = new Map(
        thisWeekByTool.map((t) => [t.tool_id, t.downloads]),
      );
      const lastWeekMap = new Map(
        lastWeekByTool.map((t) => [t.tool_id, t.downloads]),
      );

      // Get tool names
      const allToolIds = new Set([
        ...thisWeekMap.keys(),
        ...lastWeekMap.keys(),
      ]);
      const toolNames = await db
        .select({ id: tools.id, name: tools.name })
        .from(tools)
        .where(sql`${tools.id} IN (${[...allToolIds].join(",")})`)
        .all();
      const toolIdToName = new Map(toolNames.map((t) => [t.id, t.name]));

      // Calculate per-tool growth
      const toolGrowth: Array<{
        tool: string;
        thisWeek: number;
        lastWeek: number;
        wow: number | null;
      }> = [];

      for (const toolId of allToolIds) {
        const thisWeek = thisWeekMap.get(toolId) ?? 0;
        const lastWeek = lastWeekMap.get(toolId) ?? 0;
        const toolName = toolIdToName.get(toolId);

        if (!toolName) continue;

        // Only include tools with significant activity
        if (thisWeek < 10 && lastWeek < 10) continue;

        const wow =
          lastWeek > 0
            ? ((thisWeek - lastWeek) / lastWeek) * 100
            : thisWeek > 0
              ? 100
              : null;

        toolGrowth.push({
          tool: toolName,
          thisWeek,
          lastWeek,
          wow,
        });
      }

      // Sort by WoW growth, filter to top growing and declining
      const growingTools = toolGrowth
        .filter((t) => t.wow !== null && t.wow > 0)
        .sort((a, b) => (b.wow ?? 0) - (a.wow ?? 0))
        .slice(0, 10);

      const decliningTools = toolGrowth
        .filter((t) => t.wow !== null && t.wow < 0)
        .sort((a, b) => (a.wow ?? 0) - (b.wow ?? 0))
        .slice(0, 10);

      return {
        global: {
          wow: wowGrowth,
          mom: momGrowth,
          thisWeek: thisWeekTotal,
          lastWeek: lastWeekTotal,
          thisMonth: thisMonthTotal,
          lastMonth: lastMonthTotal,
        },
        topGrowing: growingTools,
        topDeclining: decliningTools,
      };
    },
  };
}
