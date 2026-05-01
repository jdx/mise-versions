// Rollup table population functions
import type { drizzle } from "drizzle-orm/d1";
import { sql, eq, and, type SQL } from "drizzle-orm";
import {
  backends,
  downloads,
  tools,
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

  async function backfillArchivedToolStats(
    d1?: D1Database,
  ): Promise<{ rowsInserted: number }> {
    // Archived rows no longer have raw ip_hash values, so downloads are exact
    // while unique_users uses the best available per-archive-group totals.
    // Only fill missing date/tool rows to avoid replacing accurate raw rollups.
    const query = `
      INSERT INTO daily_tool_stats (date, tool_id, downloads, unique_users)
      SELECT
        dd.date,
        dd.tool_id,
        SUM(dd.count) as downloads,
        SUM(dd.unique_ips) as unique_users
      FROM downloads_daily dd
      LEFT JOIN daily_tool_stats dts
        ON dts.date = dd.date
        AND dts.tool_id = dd.tool_id
      WHERE dts.tool_id IS NULL
      GROUP BY dd.date, dd.tool_id
    `;

    if (d1) {
      const result = await d1.prepare(query).run();
      return { rowsInserted: result.meta.changes ?? 0 };
    }

    await db.run(sql.raw(query));
    return { rowsInserted: 0 };
  }

  async function runStatement(
    query: SQL,
    d1?: D1Database,
    d1Query?: string,
    bindings: (string | number)[] = [],
  ): Promise<void> {
    if (d1) {
      if (!d1Query) {
        throw new Error("D1 query is required when running against D1");
      }
      await d1
        .prepare(d1Query)
        .bind(...bindings)
        .run();
      return;
    }

    await db.run(query);
  }

  async function countSummaryRows(d1?: D1Database): Promise<{
    toolSummaries: number;
    platformSummaries: number;
    versionSummaries: number;
  }> {
    if (d1) {
      const [toolRows, platformRows, versionRows] = await Promise.all([
        d1
          .prepare("SELECT COUNT(*) AS count FROM tool_download_summaries")
          .first<{ count: number }>(),
        d1
          .prepare(
            "SELECT COUNT(*) AS count FROM tool_platform_download_summaries",
          )
          .first<{ count: number }>(),
        d1
          .prepare(
            "SELECT COUNT(*) AS count FROM tool_version_download_summaries",
          )
          .first<{ count: number }>(),
      ]);
      return {
        toolSummaries: toolRows?.count ?? 0,
        platformSummaries: platformRows?.count ?? 0,
        versionSummaries: versionRows?.count ?? 0,
      };
    }

    const [toolRows, platformRows, versionRows] = await Promise.all([
      db.get<{ count: number }>(
        sql`SELECT COUNT(*) AS count FROM tool_download_summaries`,
      ),
      db.get<{ count: number }>(
        sql`SELECT COUNT(*) AS count FROM tool_platform_download_summaries`,
      ),
      db.get<{ count: number }>(
        sql`SELECT COUNT(*) AS count FROM tool_version_download_summaries`,
      ),
    ]);

    return {
      toolSummaries: toolRows?.count ?? 0,
      platformSummaries: platformRows?.count ?? 0,
      versionSummaries: versionRows?.count ?? 0,
    };
  }

  async function populateToolDownloadSummaries(d1?: D1Database): Promise<{
    toolSummaries: number;
    platformSummaries: number;
    versionSummaries: number;
  }> {
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = new Date((now - 30 * 86400) * 1000)
      .toISOString()
      .split("T")[0];
    const updatedAt = new Date().toISOString();

    await runStatement(
      sql`
        INSERT OR REPLACE INTO tool_download_summaries (
          tool_id,
          downloads_30d,
          downloads_all_time,
          updated_at
        )
        WITH all_time AS (
          SELECT tool_id, SUM(downloads) AS downloads_all_time
          FROM (
            SELECT tool_id, COUNT(*) AS downloads
            FROM downloads
            GROUP BY tool_id
            UNION ALL
            SELECT tool_id, SUM(count) AS downloads
            FROM downloads_daily
            GROUP BY tool_id
          )
          GROUP BY tool_id
        ),
        recent AS (
          SELECT tool_id, SUM(downloads) AS downloads_30d
          FROM daily_tool_stats
          WHERE date >= ${thirtyDaysAgo}
          GROUP BY tool_id
        )
        SELECT
          t.id,
          COALESCE(r.downloads_30d, 0),
          COALESCE(a.downloads_all_time, 0),
          ${updatedAt}
        FROM tools t
        LEFT JOIN all_time a ON a.tool_id = t.id
        LEFT JOIN recent r ON r.tool_id = t.id
      `,
      d1,
      `
        INSERT OR REPLACE INTO tool_download_summaries (
          tool_id,
          downloads_30d,
          downloads_all_time,
          updated_at
        )
        WITH all_time AS (
          SELECT tool_id, SUM(downloads) AS downloads_all_time
          FROM (
            SELECT tool_id, COUNT(*) AS downloads
            FROM downloads
            GROUP BY tool_id
            UNION ALL
            SELECT tool_id, SUM(count) AS downloads
            FROM downloads_daily
            GROUP BY tool_id
          )
          GROUP BY tool_id
        ),
        recent AS (
          SELECT tool_id, SUM(downloads) AS downloads_30d
          FROM daily_tool_stats
          WHERE date >= ?
          GROUP BY tool_id
        )
        SELECT
          t.id,
          COALESCE(r.downloads_30d, 0),
          COALESCE(a.downloads_all_time, 0),
          ?
        FROM tools t
        LEFT JOIN all_time a ON a.tool_id = t.id
        LEFT JOIN recent r ON r.tool_id = t.id
      `,
      [thirtyDaysAgo, updatedAt],
    );

    await runStatement(
      sql`
        INSERT OR REPLACE INTO tool_platform_download_summaries (
          tool_id,
          platform_id,
          downloads_all_time
        )
        SELECT
          tool_id,
          COALESCE(platform_id, 0) AS platform_id,
          SUM(downloads) AS downloads_all_time
        FROM (
          SELECT tool_id, platform_id, COUNT(*) AS downloads
          FROM downloads
          GROUP BY tool_id, platform_id
          UNION ALL
          SELECT tool_id, platform_id, SUM(count) AS downloads
          FROM downloads_daily
          GROUP BY tool_id, platform_id
        )
        GROUP BY tool_id, COALESCE(platform_id, 0)
      `,
      d1,
      `
        INSERT OR REPLACE INTO tool_platform_download_summaries (
          tool_id,
          platform_id,
          downloads_all_time
        )
        SELECT
          tool_id,
          COALESCE(platform_id, 0) AS platform_id,
          SUM(downloads) AS downloads_all_time
        FROM (
          SELECT tool_id, platform_id, COUNT(*) AS downloads
          FROM downloads
          GROUP BY tool_id, platform_id
          UNION ALL
          SELECT tool_id, platform_id, SUM(count) AS downloads
          FROM downloads_daily
          GROUP BY tool_id, platform_id
        )
        GROUP BY tool_id, COALESCE(platform_id, 0)
      `,
    );

    await runStatement(
      sql`
        INSERT OR REPLACE INTO tool_version_download_summaries (
          tool_id,
          version,
          downloads_all_time
        )
        SELECT
          tool_id,
          version,
          SUM(downloads) AS downloads_all_time
        FROM (
          SELECT tool_id, version, COUNT(*) AS downloads
          FROM downloads
          GROUP BY tool_id, version
          UNION ALL
          SELECT tool_id, version, SUM(count) AS downloads
          FROM downloads_daily
          GROUP BY tool_id, version
        )
        GROUP BY tool_id, version
      `,
      d1,
      `
        INSERT OR REPLACE INTO tool_version_download_summaries (
          tool_id,
          version,
          downloads_all_time
        )
        SELECT
          tool_id,
          version,
          SUM(downloads) AS downloads_all_time
        FROM (
          SELECT tool_id, version, COUNT(*) AS downloads
          FROM downloads
          GROUP BY tool_id, version
          UNION ALL
          SELECT tool_id, version, SUM(count) AS downloads
          FROM downloads_daily
          GROUP BY tool_id, version
        )
        GROUP BY tool_id, version
      `,
    );

    return countSummaryRows(d1);
  }

  async function populateBackendToolSummaries(
    d1?: D1Database,
  ): Promise<{ backendSummaries: number }> {
    const updatedAt = new Date().toISOString();

    await runStatement(
      sql`
        INSERT OR REPLACE INTO backend_tool_summaries (
          backend_type,
          tool_count,
          updated_at
        )
        SELECT
          SUBSTR(value, 1, INSTR(value || ':', ':') - 1) AS backend_type,
          COUNT(DISTINCT tools.id) AS tool_count,
          ${updatedAt}
        FROM tools, json_each(backends)
        WHERE latest_version IS NOT NULL
          AND backends IS NOT NULL
        GROUP BY backend_type
      `,
      d1,
      `
        INSERT OR REPLACE INTO backend_tool_summaries (
          backend_type,
          tool_count,
          updated_at
        )
        SELECT
          SUBSTR(value, 1, INSTR(value || ':', ':') - 1) AS backend_type,
          COUNT(DISTINCT tools.id) AS tool_count,
          ?
        FROM tools, json_each(backends)
        WHERE latest_version IS NOT NULL
          AND backends IS NOT NULL
        GROUP BY backend_type
      `,
      [updatedAt],
    );

    const refreshed = d1
      ? await d1
          .prepare(
            "SELECT COUNT(*) AS count FROM backend_tool_summaries WHERE updated_at = ?",
          )
          .bind(updatedAt)
          .first<{ count: number }>()
      : await db.get<{ count: number }>(sql`
          SELECT COUNT(*) AS count
          FROM backend_tool_summaries
          WHERE updated_at = ${updatedAt}
        `);

    if ((refreshed?.count ?? 0) > 0) {
      await runStatement(
        sql`
          DELETE FROM backend_tool_summaries
          WHERE updated_at != ${updatedAt}
        `,
        d1,
        "DELETE FROM backend_tool_summaries WHERE updated_at != ?",
        [updatedAt],
      );
    }

    const total = d1
      ? await d1
          .prepare("SELECT COUNT(*) AS count FROM backend_tool_summaries")
          .first<{ count: number }>()
      : await db.get<{ count: number }>(
          sql`SELECT COUNT(*) AS count FROM backend_tool_summaries`,
        );

    return { backendSummaries: total?.count ?? 0 };
  }

  async function populateTrendingToolSummaries(
    d1?: D1Database,
  ): Promise<{ trendingSummaries: number }> {
    const LOOKBACK_DAYS = 30;
    const SPARKLINE_DAYS = 13; // yesterday through 13 days ago; today is incomplete.
    const MIN_DOWNLOADS = 500;
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = new Date((now - LOOKBACK_DAYS * 86400) * 1000)
      .toISOString()
      .split("T")[0];
    const today = new Date(now * 1000).toISOString().split("T")[0];
    const updatedAt = new Date().toISOString();
    const lookupDates = Array.from(
      { length: LOOKBACK_DAYS },
      (_, index) =>
        new Date((now - (index + 1) * 86400) * 1000)
          .toISOString()
          .split("T")[0],
    );
    const sparklineDates = lookupDates.slice(0, SPARKLINE_DAYS).reverse();

    const dailyData = await db.all<{
      tool_id: number;
      downloads_30d: number;
      date: string;
      downloads: number;
    }>(sql`
      WITH candidates AS (
        SELECT
          daily_tool_stats.tool_id,
          SUM(daily_tool_stats.downloads) AS downloads_30d
        FROM daily_tool_stats
          INNER JOIN tools ON daily_tool_stats.tool_id = tools.id
        WHERE
          daily_tool_stats.date >= ${thirtyDaysAgo}
          AND daily_tool_stats.date < ${today}
          AND tools.latest_version IS NOT NULL
        GROUP BY daily_tool_stats.tool_id
        HAVING SUM(daily_tool_stats.downloads) >= ${MIN_DOWNLOADS}
      )
      SELECT
        daily_tool_stats.tool_id,
        candidates.downloads_30d,
        daily_tool_stats.date,
        daily_tool_stats.downloads
      FROM daily_tool_stats
        INNER JOIN candidates ON daily_tool_stats.tool_id = candidates.tool_id
      WHERE
        daily_tool_stats.date >= ${thirtyDaysAgo}
        AND daily_tool_stats.date < ${today}
      ORDER BY daily_tool_stats.date
    `);

    const toolData = new Map<
      number,
      { total: number; daily: Map<string, number> }
    >();
    for (const row of dailyData) {
      if (!toolData.has(row.tool_id)) {
        toolData.set(row.tool_id, {
          total: row.downloads_30d,
          daily: new Map(),
        });
      }
      const data = toolData.get(row.tool_id)!;
      data.daily.set(row.date, row.downloads);
    }

    const rows: Array<{
      tool_id: number;
      downloads_30d: number;
      daily_boost: number;
      trending_score: number;
      sparkline: string;
    }> = [];

    for (const [toolId, data] of toolData) {
      const dailyValues = lookupDates.map((date) => data.daily.get(date) ?? 0);

      const mean =
        dailyValues.reduce((sum, value) => sum + value, 0) / dailyValues.length;
      const variance =
        dailyValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
        dailyValues.length;
      const stddev = Math.sqrt(variance);

      if (stddev === 0) {
        continue;
      }

      const recentAvg = (dailyValues[0] + dailyValues[1] + dailyValues[2]) / 3;
      const dailyBoost = (recentAvg - mean) / stddev;
      const sparkline = sparklineDates.map((date) => data.daily.get(date) ?? 0);

      rows.push({
        tool_id: toolId,
        downloads_30d: data.total,
        daily_boost: dailyBoost,
        // Keep this separate so the ranking formula can evolve without a schema change.
        trending_score: dailyBoost,
        sparkline: JSON.stringify(sparkline),
      });
    }

    if (d1) {
      const BATCH_SIZE = 100;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        await d1.batch(
          batch.map((row) =>
            d1
              .prepare(
                "INSERT OR REPLACE INTO trending_tool_summaries (tool_id, downloads_30d, daily_boost, trending_score, sparkline, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
              )
              .bind(
                row.tool_id,
                row.downloads_30d,
                row.daily_boost,
                row.trending_score,
                row.sparkline,
                updatedAt,
              ),
          ),
        );
      }
      if (rows.length > 0) {
        await d1
          .prepare("DELETE FROM trending_tool_summaries WHERE updated_at != ?")
          .bind(updatedAt)
          .run();
      }
    } else if (rows.length > 0) {
      const BATCH_SIZE = 100;
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const values = rows.slice(i, i + BATCH_SIZE).map(
          (row) => sql`(
            ${row.tool_id},
            ${row.downloads_30d},
            ${row.daily_boost},
            ${row.trending_score},
            ${row.sparkline},
            ${updatedAt}
          )`,
        );
        await db.run(sql`
          INSERT OR REPLACE INTO trending_tool_summaries (
            tool_id,
            downloads_30d,
            daily_boost,
            trending_score,
            sparkline,
            updated_at
          )
          VALUES ${sql.join(values, sql`, `)}
        `);
      }
      await db.run(sql`
          DELETE FROM trending_tool_summaries
          WHERE updated_at != ${updatedAt}
      `);
    }

    const result = d1
      ? await d1
          .prepare("SELECT COUNT(*) AS count FROM trending_tool_summaries")
          .first<{ count: number }>()
      : await db.get<{ count: number }>(
          sql`SELECT COUNT(*) AS count FROM trending_tool_summaries`,
        );

    return { trendingSummaries: result?.count ?? 0 };
  }

  return {
    populateVersionStatsRollup,
    populateRollupTables,
    populateDailyMauStats,
    backfillArchivedToolStats,
    populateToolDownloadSummaries,
    populateBackendToolSummaries,
    populateTrendingToolSummaries,

    // Backfill rollup tables for the last N days (one-time migration)
    async backfillRollupTables(
      days: number = 90,
      d1?: D1Database,
    ): Promise<{
      daysProcessed: number;
      mauDaysProcessed: number;
      archivedToolRowsInserted: number;
    }> {
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

      const archived = await backfillArchivedToolStats(d1);
      await populateToolDownloadSummaries(d1);
      await populateBackendToolSummaries(d1);
      await populateTrendingToolSummaries(d1);

      return {
        daysProcessed,
        mauDaysProcessed,
        archivedToolRowsInserted: archived.rowsInserted,
      };
    },
  };
}
