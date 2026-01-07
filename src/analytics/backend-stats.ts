// Backend statistics functions
import type { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { tools, dailyBackendStats, dailyToolBackendStats } from "./schema.js";

export function createBackendStatsFunctions(db: ReturnType<typeof drizzle>) {
  // Get 30-day downloads by backend type
  // Uses daily_backend_stats rollup table for fast lookups
  async function getDownloadsByBackend() {
    const now = Math.floor(Date.now() / 1000);
    const startDate = new Date((now - 30 * 86400) * 1000).toISOString().split("T")[0];

    // Sum downloads from rollup table (fast!)
    const results = await db
      .select({
        backend: dailyBackendStats.backend_type,
        count: sql<number>`sum(${dailyBackendStats.downloads})`,
      })
      .from(dailyBackendStats)
      .where(sql`${dailyBackendStats.date} >= ${startDate}`)
      .groupBy(dailyBackendStats.backend_type)
      .all();

    // Sort by count descending
    const sorted = results
      .sort((a, b) => b.count - a.count)
      .map((r) => ({ backend: r.backend, count: r.count }));

    return sorted;
  }

  // Get top tools by backend type (30 days)
  // Uses daily_tool_backend_stats rollup table for fast lookups
  async function getTopToolsByBackend(limit: number = 5) {
    const now = Math.floor(Date.now() / 1000);
    const startDate = new Date((now - 30 * 86400) * 1000).toISOString().split("T")[0];

    // Sum downloads from rollup table grouped by tool and backend type (fast!)
    const results = await db
      .select({
        tool_id: dailyToolBackendStats.tool_id,
        backend_type: dailyToolBackendStats.backend_type,
        count: sql<number>`sum(${dailyToolBackendStats.downloads})`,
      })
      .from(dailyToolBackendStats)
      .where(sql`${dailyToolBackendStats.date} >= ${startDate}`)
      .groupBy(dailyToolBackendStats.tool_id, dailyToolBackendStats.backend_type)
      .all();

    // Get tool names for the tool IDs we found (batch to avoid D1 param limit)
    const toolIds = [...new Set(results.map(r => r.tool_id))];
    if (toolIds.length === 0) {
      return {};
    }

    const toolIdToName = new Map<number, string>();
    const BATCH_SIZE = 99;
    for (let i = 0; i < toolIds.length; i += BATCH_SIZE) {
      const batch = toolIds.slice(i, i + BATCH_SIZE);
      const toolNames = await db
        .select({ id: tools.id, name: tools.name })
        .from(tools)
        .where(sql`${tools.id} IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})`)
        .all();
      for (const t of toolNames) {
        toolIdToName.set(t.id, t.name);
      }
    }

    // Group by backend type, then get top tools per type
    const byBackendType = new Map<string, Map<string, number>>();

    for (const r of results) {
      const toolName = toolIdToName.get(r.tool_id);
      if (!toolName) continue;

      const backendType = r.backend_type || "unknown";

      if (!byBackendType.has(backendType)) {
        byBackendType.set(backendType, new Map());
      }
      const toolMap = byBackendType.get(backendType)!;
      toolMap.set(toolName, (toolMap.get(toolName) || 0) + r.count);
    }

    // Convert to result format with top tools per backend
    const result: Record<string, Array<{ tool: string; count: number }>> = {};

    for (const [backendType, toolMap] of byBackendType.entries()) {
      const topTools = [...toolMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([tool, count]) => ({ tool, count }));
      result[backendType] = topTools;
    }

    return result;
  }

  return {
    getDownloadsByBackend,
    getTopToolsByBackend,

    // Get all backend stats (combined endpoint for efficiency)
    async getBackendStats() {
      const [downloadsByBackend, topToolsByBackend] = await Promise.all([
        getDownloadsByBackend(),
        getTopToolsByBackend(),
      ]);

      return {
        downloads_by_backend: downloadsByBackend,
        top_tools_by_backend: topToolsByBackend,
      };
    },
  };
}
