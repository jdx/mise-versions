// Rollup table population functions
import type { drizzle } from "drizzle-orm/d1";
import { sql, eq, and } from "drizzle-orm";
import {
  backends,
  downloads,
  dailyStats,
  dailyToolStats,
  dailyBackendStats,
  dailyToolBackendStats,
  dailyCombinedStats,
  dailyMauStats,
  versionRequests,
  dailyVersionStats,
} from "./schema.js";

export function createRollupFunctions(db: ReturnType<typeof drizzle>) {
  // Populate daily_version_stats rollup table for a specific date
  async function populateVersionStatsRollup(
    date: string,
    d1?: D1Database,
  ): Promise<boolean> {
    const dateStart = Math.floor(
      new Date(date + "T00:00:00Z").getTime() / 1000,
    );
    const dateEnd = dateStart + 86400;

    const stats = await db
      .select({
        total: sql<number>`count(*)`,
        unique_users: sql<number>`count(distinct ip_hash)`,
      })
      .from(versionRequests)
      .where(
        and(
          sql`${versionRequests.created_at} >= ${dateStart}`,
          sql`${versionRequests.created_at} < ${dateEnd}`,
        ),
      )
      .get();

    if (stats && stats.total > 0) {
      if (d1) {
        await d1
          .prepare(
            "INSERT OR REPLACE INTO daily_version_stats (date, total_requests, unique_users) VALUES (?, ?, ?)",
          )
          .bind(date, stats.total, stats.unique_users)
          .run();
      } else {
        await db.run(sql`
          INSERT OR REPLACE INTO daily_version_stats (date, total_requests, unique_users)
          VALUES (${date}, ${stats.total}, ${stats.unique_users})
        `);
      }
      return true;
    }
    return false;
  }

  // Populate rollup tables for a specific date (call daily via cron)
  async function populateRollupTables(
    date: string,
    d1?: D1Database,
  ): Promise<{
    dailyStats: boolean;
    combinedStats: boolean;
    toolStats: number;
    backendStats: number;
    toolBackendStats: number;
  }> {
    // Calculate timestamp range for the date (UTC)
    const dateStart = Math.floor(
      new Date(date + "T00:00:00Z").getTime() / 1000,
    );
    const dateEnd = dateStart + 86400;

    // 1. Populate daily_stats
    const globalStats = await db
      .select({
        total: sql<number>`count(*)`,
        unique_users: sql<number>`count(distinct ip_hash)`,
      })
      .from(downloads)
      .where(
        and(
          sql`${downloads.created_at} >= ${dateStart}`,
          sql`${downloads.created_at} < ${dateEnd}`,
        ),
      )
      .get();

    if (globalStats && globalStats.total > 0) {
      if (d1) {
        await d1
          .prepare(
            "INSERT OR REPLACE INTO daily_stats (date, total_downloads, unique_users) VALUES (?, ?, ?)",
          )
          .bind(date, globalStats.total, globalStats.unique_users)
          .run();
      } else {
        await db.run(sql`
          INSERT OR REPLACE INTO daily_stats (date, total_downloads, unique_users)
          VALUES (${date}, ${globalStats.total}, ${globalStats.unique_users})
        `);
      }
    }

    // 1b. Populate daily_combined_stats (combined unique users from downloads + version_requests)
    let combinedDau = 0;
    if (d1) {
      // Use raw D1 query to avoid parameter binding issues in subqueries
      const combinedResult = await d1
        .prepare(
          `
        SELECT COUNT(DISTINCT ip_hash) as unique_users FROM (
          SELECT ip_hash FROM downloads WHERE created_at >= ? AND created_at < ?
          UNION
          SELECT ip_hash FROM version_requests WHERE created_at >= ? AND created_at < ?
        )
      `,
        )
        .bind(dateStart, dateEnd, dateStart, dateEnd)
        .first<{ unique_users: number }>();
      combinedDau = combinedResult?.unique_users ?? 0;
    } else {
      const combinedDauResult = await db
        .select({
          unique_users: sql<number>`count(distinct ip_hash)`,
        })
        .from(
          sql`(
            SELECT ip_hash FROM downloads WHERE created_at >= ${dateStart} AND created_at < ${dateEnd}
            UNION
            SELECT ip_hash FROM version_requests WHERE created_at >= ${dateStart} AND created_at < ${dateEnd}
          )`,
        )
        .get();
      combinedDau = combinedDauResult?.unique_users ?? 0;
    }
    if (combinedDau > 0) {
      if (d1) {
        await d1
          .prepare(
            "INSERT OR REPLACE INTO daily_combined_stats (date, unique_users) VALUES (?, ?)",
          )
          .bind(date, combinedDau)
          .run();
      } else {
        await db.run(sql`
          INSERT OR REPLACE INTO daily_combined_stats (date, unique_users)
          VALUES (${date}, ${combinedDau})
        `);
      }
    }

    // 2. Populate daily_tool_stats
    const toolStats = await db
      .select({
        tool_id: downloads.tool_id,
        downloads: sql<number>`count(*)`,
        unique_users: sql<number>`count(distinct ip_hash)`,
      })
      .from(downloads)
      .where(
        and(
          sql`${downloads.created_at} >= ${dateStart}`,
          sql`${downloads.created_at} < ${dateEnd}`,
        ),
      )
      .groupBy(downloads.tool_id)
      .all();

    if (d1 && toolStats.length > 0) {
      const BATCH_SIZE = 50;
      for (let i = 0; i < toolStats.length; i += BATCH_SIZE) {
        const batch = toolStats.slice(i, i + BATCH_SIZE);
        const statements = batch.map((stat) =>
          d1
            .prepare(
              "INSERT OR REPLACE INTO daily_tool_stats (date, tool_id, downloads, unique_users) VALUES (?, ?, ?, ?)",
            )
            .bind(date, stat.tool_id, stat.downloads, stat.unique_users),
        );
        await d1.batch(statements);
      }
    } else {
      for (const stat of toolStats) {
        await db.run(sql`
          INSERT OR REPLACE INTO daily_tool_stats (date, tool_id, downloads, unique_users)
          VALUES (${date}, ${stat.tool_id}, ${stat.downloads}, ${stat.unique_users})
        `);
      }
    }

    // 3. Populate daily_backend_stats
    const backendResults = await db
      .select({
        backend_full: backends.full,
        downloads: sql<number>`count(*)`,
        unique_users: sql<number>`count(distinct ip_hash)`,
      })
      .from(downloads)
      .leftJoin(backends, eq(downloads.backend_id, backends.id))
      .where(
        and(
          sql`${downloads.created_at} >= ${dateStart}`,
          sql`${downloads.created_at} < ${dateEnd}`,
        ),
      )
      .groupBy(backends.full)
      .all();

    // Group by backend type (prefix before colon)
    const backendTypeStats = new Map<
      string,
      { downloads: number; unique_users: number }
    >();
    for (const r of backendResults) {
      const backendType = r.backend_full
        ? r.backend_full.split(":")[0]
        : "unknown";
      const existing = backendTypeStats.get(backendType) || {
        downloads: 0,
        unique_users: 0,
      };
      existing.downloads += r.downloads;
      existing.unique_users += r.unique_users;
      backendTypeStats.set(backendType, existing);
    }

    if (d1 && backendTypeStats.size > 0) {
      const statements = [...backendTypeStats].map(([backendType, stat]) =>
        d1
          .prepare(
            "INSERT OR REPLACE INTO daily_backend_stats (date, backend_type, downloads, unique_users) VALUES (?, ?, ?, ?)",
          )
          .bind(date, backendType, stat.downloads, stat.unique_users),
      );
      await d1.batch(statements);
    } else {
      for (const [backendType, stat] of backendTypeStats) {
        await db.run(sql`
          INSERT OR REPLACE INTO daily_backend_stats (date, backend_type, downloads, unique_users)
          VALUES (${date}, ${backendType}, ${stat.downloads}, ${stat.unique_users})
        `);
      }
    }

    // 4. Populate daily_tool_backend_stats (for fast top-tools-by-backend queries)
    const toolBackendResults = await db
      .select({
        tool_id: downloads.tool_id,
        backend_full: backends.full,
        downloads: sql<number>`count(*)`,
      })
      .from(downloads)
      .leftJoin(backends, eq(downloads.backend_id, backends.id))
      .where(
        and(
          sql`${downloads.created_at} >= ${dateStart}`,
          sql`${downloads.created_at} < ${dateEnd}`,
        ),
      )
      .groupBy(downloads.tool_id, backends.full)
      .all();

    // Group by tool_id and backend_type
    const toolBackendStats: Array<{
      tool_id: number;
      backend_type: string;
      downloads: number;
    }> = [];
    for (const r of toolBackendResults) {
      const backendType = r.backend_full
        ? r.backend_full.split(":")[0]
        : "unknown";
      toolBackendStats.push({
        tool_id: r.tool_id,
        backend_type: backendType,
        downloads: r.downloads,
      });
    }

    if (d1 && toolBackendStats.length > 0) {
      const BATCH_SIZE = 50;
      for (let i = 0; i < toolBackendStats.length; i += BATCH_SIZE) {
        const batch = toolBackendStats.slice(i, i + BATCH_SIZE);
        const statements = batch.map((stat) =>
          d1
            .prepare(
              "INSERT OR REPLACE INTO daily_tool_backend_stats (date, tool_id, backend_type, downloads) VALUES (?, ?, ?, ?)",
            )
            .bind(date, stat.tool_id, stat.backend_type, stat.downloads),
        );
        await d1.batch(statements);
      }
    } else {
      for (const stat of toolBackendStats) {
        await db.run(sql`
          INSERT OR REPLACE INTO daily_tool_backend_stats (date, tool_id, backend_type, downloads)
          VALUES (${date}, ${stat.tool_id}, ${stat.backend_type}, ${stat.downloads})
        `);
      }
    }

    return {
      dailyStats: (globalStats?.total ?? 0) > 0,
      combinedStats: combinedDau > 0,
      toolStats: toolStats.length,
      backendStats: backendTypeStats.size,
      toolBackendStats: toolBackendStats.length,
    };
  }

  // Populate daily MAU stats for a specific date
  // MAU = unique users in the 30 days ending on this date (across downloads + version_requests)
  async function populateDailyMauStats(
    date: string,
    d1?: D1Database,
  ): Promise<boolean> {
    // Calculate the 30-day window ending on this date
    const dateEnd = Math.floor(new Date(date + "T23:59:59Z").getTime() / 1000);
    const dateStart = dateEnd - 30 * 86400;

    // Count unique users across both tables in the 30-day window
    let mau = 0;
    if (d1) {
      // Use raw D1 query to avoid parameter binding issues in subqueries
      const mauResult = await d1
        .prepare(
          `
        SELECT COUNT(DISTINCT ip_hash) as mau FROM (
          SELECT ip_hash FROM downloads WHERE created_at >= ? AND created_at <= ?
          UNION
          SELECT ip_hash FROM version_requests WHERE created_at >= ? AND created_at <= ?
        )
      `,
        )
        .bind(dateStart, dateEnd, dateStart, dateEnd)
        .first<{ mau: number }>();
      mau = mauResult?.mau ?? 0;
    } else {
      const mauResult = await db
        .select({
          mau: sql<number>`count(distinct ip_hash)`,
        })
        .from(
          sql`(
            SELECT ip_hash FROM downloads WHERE created_at >= ${dateStart} AND created_at <= ${dateEnd}
            UNION
            SELECT ip_hash FROM version_requests WHERE created_at >= ${dateStart} AND created_at <= ${dateEnd}
          )`,
        )
        .get();
      mau = mauResult?.mau ?? 0;
    }

    if (mau > 0) {
      if (d1) {
        await d1
          .prepare(
            "INSERT OR REPLACE INTO daily_mau_stats (date, mau) VALUES (?, ?)",
          )
          .bind(date, mau)
          .run();
      } else {
        await db.run(sql`
          INSERT OR REPLACE INTO daily_mau_stats (date, mau)
          VALUES (${date}, ${mau})
        `);
      }
      return true;
    }
    return false;
  }

  return {
    populateVersionStatsRollup,
    populateRollupTables,
    populateDailyMauStats,

    // Backfill rollup tables for the last N days (one-time migration)
    async backfillRollupTables(
      days: number = 90,
      d1?: D1Database,
    ): Promise<{ daysProcessed: number; mauDaysProcessed: number }> {
      let daysProcessed = 0;
      let mauDaysProcessed = 0;
      const now = new Date();

      for (let i = 0; i < days; i++) {
        const date = new Date(now);
        date.setUTCDate(date.getUTCDate() - i);
        const dateStr = date.toISOString().split("T")[0];

        // Populate standard rollup tables (daily_stats, daily_combined_stats, daily_tool_stats, etc.)
        const result = await populateRollupTables(dateStr, d1);
        if (result.dailyStats) {
          daysProcessed++;
        }

        // Populate daily MAU stats (trailing 30-day MAU for this date)
        const mauResult = await populateDailyMauStats(dateStr, d1);
        if (mauResult) {
          mauDaysProcessed++;
        }
      }

      return { daysProcessed, mauDaysProcessed };
    },
  };
}
