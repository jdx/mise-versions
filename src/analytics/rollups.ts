// Rollup table population functions
import type { drizzle } from "drizzle-orm/d1";
import { sql, eq, and, type SQL } from "drizzle-orm";
import { tools, platforms } from "./schema.js";
import {
  analyticsEngineCoversDate,
  analyticsEngineDataset,
  dateRangeSql,
  hasAnalyticsEngineSql,
  queryAnalyticsEngine,
  type AnalyticsEngineSqlConfig,
} from "./analytics-engine.js";

interface RollupOptions {
  analyticsEngine?: AnalyticsEngineSqlConfig;
}

interface AeCountRow {
  total: number;
  unique_users: number;
}

interface AeToolRow {
  tool: string;
  downloads: number;
  unique_users: number;
}

interface AeBackendRow {
  backend_type: string;
  downloads: number;
  unique_users: number;
}

interface AeToolBackendRow {
  tool: string;
  backend_type: string;
  downloads: number;
}

interface AeVersionRow {
  tool: string;
  version: string;
  downloads: number;
}

interface AePlatformRow {
  tool: string;
  os: string;
  arch: string;
  downloads: number;
}

export function createRollupFunctions(
  db: ReturnType<typeof drizzle>,
  options: RollupOptions = {},
) {
  const analyticsEngine = options.analyticsEngine;

  function aeNumber(value: unknown): number {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  function datasetSql() {
    return analyticsEngineDataset(analyticsEngine);
  }

  async function countMauFromAnalyticsEngine(
    table: string,
    start: string,
    end: string,
  ): Promise<number> {
    const result = await queryAnalyticsEngine<{ mau: number }>(
      analyticsEngine!,
      `
        SELECT count(DISTINCT index1) AS mau
        FROM ${table}
        WHERE
          blob1 IN ('download', 'version_request')
          AND timestamp >= toDateTime('${start}')
          AND timestamp <= toDateTime('${end}')
      `,
    );

    return aeNumber(result.rows[0]?.mau);
  }

  async function loadToolIds(
    names: Iterable<string>,
  ): Promise<Map<string, number>> {
    const unique = [...new Set([...names].filter(Boolean))];
    const result = new Map<string, number>();
    if (unique.length === 0) return result;

    const BATCH_SIZE = 99;
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      const batch = unique.slice(i, i + BATCH_SIZE);
      const rows = await db
        .select({ id: tools.id, name: tools.name })
        .from(tools)
        .where(
          sql`${tools.name} IN (${sql.join(
            batch.map((name) => sql`${name}`),
            sql`, `,
          )})`,
        )
        .all();
      for (const row of rows) {
        result.set(row.name, row.id);
      }
    }

    return result;
  }

  async function getOrCreatePlatformId(
    os: string | null,
    arch: string | null,
    d1?: D1Database,
  ): Promise<number> {
    if (!os && !arch) return 0;

    const existing = await db
      .select({ id: platforms.id })
      .from(platforms)
      .where(
        and(
          os ? eq(platforms.os, os) : sql`${platforms.os} IS NULL`,
          arch ? eq(platforms.arch, arch) : sql`${platforms.arch} IS NULL`,
        ),
      )
      .get();
    if (existing) return existing.id;

    if (d1) {
      await d1
        .prepare("INSERT INTO platforms (os, arch) VALUES (?, ?)")
        .bind(os, arch)
        .run();
    } else {
      await db.insert(platforms).values({ os, arch });
    }

    const inserted = await db
      .select({ id: platforms.id })
      .from(platforms)
      .where(
        and(
          os ? eq(platforms.os, os) : sql`${platforms.os} IS NULL`,
          arch ? eq(platforms.arch, arch) : sql`${platforms.arch} IS NULL`,
        ),
      )
      .get();

    return inserted?.id ?? 0;
  }

  async function populateVersionStatsRollupFromAnalyticsEngine(
    date: string,
    d1?: D1Database,
  ): Promise<boolean | null> {
    if (!hasAnalyticsEngineSql(analyticsEngine)) return null;
    if (!analyticsEngineCoversDate(analyticsEngine, date)) return null;

    const { start, end } = dateRangeSql(date);
    const table = datasetSql();
    const result = await queryAnalyticsEngine<AeCountRow>(
      analyticsEngine!,
      `
        SELECT
          sum(_sample_interval) AS total,
          count(DISTINCT index1) AS unique_users
        FROM ${table}
        WHERE
          blob1 = 'version_request'
          AND timestamp >= toDateTime('${start}')
          AND timestamp <= toDateTime('${end}')
      `,
    );

    const stats = result.rows[0];
    const total = aeNumber(stats?.total);
    const uniqueUsers = aeNumber(stats?.unique_users);

    if (d1) {
      await d1
        .prepare(
          "INSERT OR REPLACE INTO daily_version_stats (date, total_requests, unique_users) VALUES (?, ?, ?)",
        )
        .bind(date, total, uniqueUsers)
        .run();
    } else {
      await db.run(sql`
        INSERT OR REPLACE INTO daily_version_stats (date, total_requests, unique_users)
        VALUES (${date}, ${total}, ${uniqueUsers})
      `);
    }

    return true;
  }

  async function populateRollupTablesFromAnalyticsEngine(
    date: string,
    d1?: D1Database,
  ): Promise<{
    dailyStats: boolean;
    combinedStats: boolean;
    toolStats: number;
    backendStats: number;
    toolBackendStats: number;
  } | null> {
    if (!hasAnalyticsEngineSql(analyticsEngine)) return null;
    if (!analyticsEngineCoversDate(analyticsEngine, date)) return null;

    const { start, end } = dateRangeSql(date);
    const table = datasetSql();
    const range = `
      timestamp >= toDateTime('${start}')
      AND timestamp <= toDateTime('${end}')
    `;
    const dedupedDownloads = `
      (
        SELECT
          index1 AS ip_hash,
          blob2 AS tool,
          blob3 AS version,
          argMax(blob4, timestamp) AS os,
          argMax(blob5, timestamp) AS arch,
          argMax(blob7, timestamp) AS backend_type,
          argMax(_sample_interval, timestamp) AS sample_weight
        FROM ${table}
        WHERE blob1 = 'download' AND ${range}
        GROUP BY index1, blob2, blob3
      )
    `;

    // Start the high-cardinality work immediately, but handle its rejection
    // so it cannot become unhandled while the core activity queries finish.
    // This keeps all Analytics Engine requests concurrent without allowing a
    // dimension failure to prevent the user-visible totals from being saved.
    const dimensionRowsPromise = Promise.all([
      queryAnalyticsEngine<AeToolRow>(
        analyticsEngine!,
        `
          SELECT
            tool,
            sum(sample_weight) AS downloads,
            count(DISTINCT ip_hash) AS unique_users
          FROM ${dedupedDownloads}
          GROUP BY tool
        `,
      ),
      queryAnalyticsEngine<AeBackendRow>(
        analyticsEngine!,
        `
          SELECT
            backend_type,
            sum(sample_weight) AS downloads,
            count(DISTINCT ip_hash) AS unique_users
          FROM ${dedupedDownloads}
          GROUP BY backend_type
        `,
      ),
      queryAnalyticsEngine<AeToolBackendRow>(
        analyticsEngine!,
        `
          SELECT
            tool,
            backend_type,
            sum(sample_weight) AS downloads
          FROM ${dedupedDownloads}
          GROUP BY tool, backend_type
        `,
      ),
      queryAnalyticsEngine<AeVersionRow>(
        analyticsEngine!,
        `
          SELECT
            tool,
            version,
            sum(sample_weight) AS downloads
          FROM ${dedupedDownloads}
          GROUP BY tool, version
        `,
      ),
      queryAnalyticsEngine<AePlatformRow>(
        analyticsEngine!,
        `
          SELECT
            tool,
            os,
            arch,
            sum(sample_weight) AS downloads
          FROM ${dedupedDownloads}
          GROUP BY tool, os, arch
        `,
      ),
    ]).then(
      (rows) => ({ ok: true as const, rows }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    // Persist the two small, user-visible activity rollups as soon as they
    // finish, before awaiting the concurrently running dimension queries.
    const [globalRows, combinedRows] = await Promise.all([
      queryAnalyticsEngine<AeCountRow>(
        analyticsEngine!,
        `
          SELECT
            sum(sample_weight) AS total,
            count(DISTINCT ip_hash) AS unique_users
          FROM ${dedupedDownloads}
        `,
      ),
      queryAnalyticsEngine<{ unique_users: number }>(
        analyticsEngine!,
        `
          SELECT count(DISTINCT index1) AS unique_users
          FROM ${table}
          WHERE blob1 IN ('download', 'version_request') AND ${range}
        `,
      ),
    ]);

    const globalStats = globalRows.rows[0]
      ? {
          total: aeNumber(globalRows.rows[0].total),
          unique_users: aeNumber(globalRows.rows[0].unique_users),
        }
      : undefined;
    const combinedDau = aeNumber(combinedRows.rows[0]?.unique_users);

    if (globalStats) {
      await runStatement(
        sql`
          INSERT OR REPLACE INTO daily_stats (date, total_downloads, unique_users)
          VALUES (${date}, ${globalStats.total}, ${globalStats.unique_users})
        `,
        d1,
        "INSERT OR REPLACE INTO daily_stats (date, total_downloads, unique_users) VALUES (?, ?, ?)",
        [date, globalStats.total, globalStats.unique_users],
      );
    }

    if (combinedDau > 0) {
      await runStatement(
        sql`
          INSERT OR REPLACE INTO daily_combined_stats (date, unique_users)
          VALUES (${date}, ${combinedDau})
        `,
        d1,
        "INSERT OR REPLACE INTO daily_combined_stats (date, unique_users) VALUES (?, ?)",
        [date, combinedDau],
      );
    }

    const dimensionResult = await dimensionRowsPromise;
    if (!dimensionResult.ok) throw dimensionResult.error;
    const [toolRows, backendRows, toolBackendRows, versionRows, platformRows] =
      dimensionResult.rows;

    const toolStatsRows = toolRows.rows.map((row) => ({
      ...row,
      downloads: aeNumber(row.downloads),
      unique_users: aeNumber(row.unique_users),
    }));
    const backendStatsRows = backendRows.rows.map((row) => ({
      ...row,
      downloads: aeNumber(row.downloads),
      unique_users: aeNumber(row.unique_users),
    }));
    const toolBackendStatsRows = toolBackendRows.rows.map((row) => ({
      ...row,
      downloads: aeNumber(row.downloads),
    }));
    const versionStatsRows = versionRows.rows.map((row) => ({
      ...row,
      downloads: aeNumber(row.downloads),
    }));
    const platformStatsRows = platformRows.rows.map((row) => ({
      ...row,
      downloads: aeNumber(row.downloads),
    }));

    if (!globalStats && combinedDau <= 0) {
      return null;
    }

    const toolIds = await loadToolIds([
      ...toolStatsRows.map((r) => r.tool),
      ...toolBackendStatsRows.map((r) => r.tool),
      ...versionStatsRows.map((r) => r.tool),
      ...platformStatsRows.map((r) => r.tool),
    ]);

    await upsertDailyToolRows(
      date,
      toolStatsRows
        .map((row) => ({
          tool_id: toolIds.get(row.tool),
          downloads: row.downloads,
          unique_users: row.unique_users,
        }))
        .filter(
          (
            row,
          ): row is {
            tool_id: number;
            downloads: number;
            unique_users: number;
          } => typeof row.tool_id === "number",
        ),
      d1,
    );

    await upsertDailyBackendRows(date, backendStatsRows, d1);

    await upsertDailyToolBackendRows(
      date,
      toolBackendStatsRows
        .map((row) => ({
          tool_id: toolIds.get(row.tool),
          backend_type: row.backend_type || "unknown",
          downloads: row.downloads,
        }))
        .filter(
          (
            row,
          ): row is {
            tool_id: number;
            backend_type: string;
            downloads: number;
          } => typeof row.tool_id === "number",
        ),
      d1,
    );

    await upsertDailyToolVersionRows(
      date,
      versionStatsRows
        .map((row) => ({
          tool_id: toolIds.get(row.tool),
          version: row.version,
          downloads: row.downloads,
        }))
        .filter(
          (
            row,
          ): row is {
            tool_id: number;
            version: string;
            downloads: number;
          } => typeof row.tool_id === "number" && row.version.length > 0,
        ),
      d1,
    );

    const platformStats: Array<{
      tool_id: number;
      platform_id: number;
      downloads: number;
    }> = [];
    for (const row of platformStatsRows) {
      const toolId = toolIds.get(row.tool);
      if (!toolId) continue;

      const platformId = await getOrCreatePlatformId(
        row.os || null,
        row.arch || null,
        d1,
      );
      platformStats.push({
        tool_id: toolId,
        platform_id: platformId,
        downloads: row.downloads,
      });
    }
    await upsertDailyToolPlatformRows(date, platformStats, d1);

    return {
      dailyStats: (globalStats?.total ?? 0) > 0,
      combinedStats: combinedDau > 0,
      toolStats: toolStatsRows.length,
      backendStats: backendStatsRows.length,
      toolBackendStats: toolBackendStatsRows.length,
    };
  }

  async function populateDailyMauStatsFromAnalyticsEngine(
    date: string,
    d1?: D1Database,
  ): Promise<boolean | null> {
    if (!hasAnalyticsEngineSql(analyticsEngine)) return null;
    if (!analyticsEngineCoversDate(analyticsEngine, date)) return null;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Invalid date for Analytics Engine query: ${date}`);
    }

    const end = `${date} 23:59:59`;
    const startDate = new Date(`${date}T23:59:59Z`);
    startDate.setUTCDate(startDate.getUTCDate() - 30);
    const start = startDate.toISOString().replace("T", " ").slice(0, 19);
    // The trailing window must lie entirely within Analytics Engine data;
    // writing a partial-window count would replace a complete historical row
    // with an undercount.
    if (!analyticsEngineCoversDate(analyticsEngine, start.slice(0, 10))) {
      return null;
    }
    const table = datasetSql();

    const mau = await countMauFromAnalyticsEngine(table, start, end);
    if (mau <= 0) return null;

    await runStatement(
      sql`
        INSERT OR REPLACE INTO daily_mau_stats (date, mau)
        VALUES (${date}, ${mau})
      `,
      d1,
      "INSERT OR REPLACE INTO daily_mau_stats (date, mau) VALUES (?, ?)",
      [date, mau],
    );

    return true;
  }

  async function upsertDailyToolRows(
    date: string,
    rows: Array<{ tool_id: number; downloads: number; unique_users: number }>,
    d1?: D1Database,
  ) {
    if (d1 && rows.length > 0) {
      await batchD1(
        d1,
        rows.map((row) =>
          d1
            .prepare(
              "INSERT OR REPLACE INTO daily_tool_stats (date, tool_id, downloads, unique_users) VALUES (?, ?, ?, ?)",
            )
            .bind(date, row.tool_id, row.downloads, row.unique_users),
        ),
      );
      return;
    }

    for (const row of rows) {
      await db.run(sql`
        INSERT OR REPLACE INTO daily_tool_stats (date, tool_id, downloads, unique_users)
        VALUES (${date}, ${row.tool_id}, ${row.downloads}, ${row.unique_users})
      `);
    }
  }

  async function upsertDailyBackendRows(
    date: string,
    rows: Array<{
      backend_type: string;
      downloads: number;
      unique_users: number;
    }>,
    d1?: D1Database,
  ) {
    if (d1 && rows.length > 0) {
      await batchD1(
        d1,
        rows.map((row) =>
          d1
            .prepare(
              "INSERT OR REPLACE INTO daily_backend_stats (date, backend_type, downloads, unique_users) VALUES (?, ?, ?, ?)",
            )
            .bind(
              date,
              row.backend_type || "unknown",
              row.downloads,
              row.unique_users,
            ),
        ),
      );
      return;
    }

    for (const row of rows) {
      await db.run(sql`
        INSERT OR REPLACE INTO daily_backend_stats (date, backend_type, downloads, unique_users)
        VALUES (${date}, ${row.backend_type || "unknown"}, ${row.downloads}, ${row.unique_users})
      `);
    }
  }

  async function upsertDailyToolBackendRows(
    date: string,
    rows: Array<{ tool_id: number; backend_type: string; downloads: number }>,
    d1?: D1Database,
  ) {
    if (d1 && rows.length > 0) {
      await batchD1(
        d1,
        rows.map((row) =>
          d1
            .prepare(
              "INSERT OR REPLACE INTO daily_tool_backend_stats (date, tool_id, backend_type, downloads) VALUES (?, ?, ?, ?)",
            )
            .bind(date, row.tool_id, row.backend_type, row.downloads),
        ),
      );
      return;
    }

    for (const row of rows) {
      await db.run(sql`
        INSERT OR REPLACE INTO daily_tool_backend_stats (date, tool_id, backend_type, downloads)
        VALUES (${date}, ${row.tool_id}, ${row.backend_type}, ${row.downloads})
      `);
    }
  }

  async function upsertDailyToolVersionRows(
    date: string,
    rows: Array<{ tool_id: number; version: string; downloads: number }>,
    d1?: D1Database,
  ) {
    if (d1 && rows.length > 0) {
      await batchD1(
        d1,
        rows.map((row) =>
          d1
            .prepare(
              "INSERT OR REPLACE INTO daily_tool_version_stats (date, tool_id, version, downloads) VALUES (?, ?, ?, ?)",
            )
            .bind(date, row.tool_id, row.version, row.downloads),
        ),
      );
      return;
    }

    for (const row of rows) {
      await db.run(sql`
        INSERT OR REPLACE INTO daily_tool_version_stats (date, tool_id, version, downloads)
        VALUES (${date}, ${row.tool_id}, ${row.version}, ${row.downloads})
      `);
    }
  }

  async function upsertDailyToolPlatformRows(
    date: string,
    rows: Array<{ tool_id: number; platform_id: number; downloads: number }>,
    d1?: D1Database,
  ) {
    if (d1 && rows.length > 0) {
      await batchD1(
        d1,
        rows.map((row) =>
          d1
            .prepare(
              "INSERT OR REPLACE INTO daily_tool_platform_stats (date, tool_id, platform_id, downloads) VALUES (?, ?, ?, ?)",
            )
            .bind(date, row.tool_id, row.platform_id, row.downloads),
        ),
      );
      return;
    }

    for (const row of rows) {
      await db.run(sql`
        INSERT OR REPLACE INTO daily_tool_platform_stats (date, tool_id, platform_id, downloads)
        VALUES (${date}, ${row.tool_id}, ${row.platform_id}, ${row.downloads})
      `);
    }
  }

  async function batchD1(
    d1: D1Database,
    statements: D1PreparedStatement[],
  ): Promise<void> {
    const BATCH_SIZE = 50;
    for (let i = 0; i < statements.length; i += BATCH_SIZE) {
      await d1.batch(statements.slice(i, i + BATCH_SIZE));
    }
  }

  // Populate daily_version_stats rollup table for a specific date. Returns
  // false when Analytics Engine is not configured or does not cover the date.
  async function populateVersionStatsRollup(
    date: string,
    d1?: D1Database,
  ): Promise<boolean> {
    return (
      (await populateVersionStatsRollupFromAnalyticsEngine(date, d1)) ?? false
    );
  }

  // Populate rollup tables for a specific date. Reports nothing refreshed when
  // Analytics Engine is not configured, does not cover the date, or has no
  // events for it.
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
    return (
      (await populateRollupTablesFromAnalyticsEngine(date, d1)) ?? {
        dailyStats: false,
        combinedStats: false,
        toolStats: 0,
        backendStats: 0,
        toolBackendStats: 0,
      }
    );
  }

  // Populate daily MAU stats for a specific date
  // MAU = unique users in the 30 days ending on this date (across downloads +
  // version requests). Returns false when Analytics Engine is not configured
  // or does not cover the whole window.
  async function populateDailyMauStats(
    date: string,
    d1?: D1Database,
  ): Promise<boolean> {
    return (await populateDailyMauStatsFromAnalyticsEngine(date, d1)) ?? false;
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
          FROM daily_tool_stats
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
          FROM daily_tool_stats
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
        FROM daily_tool_platform_stats
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
        FROM daily_tool_platform_stats
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
        FROM daily_tool_version_stats
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
        FROM daily_tool_version_stats
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
    }> {
      let daysProcessed = 0;
      let mauDaysProcessed = 0;
      const now = new Date();

      // Start at yesterday: the current UTC day is still open, and a rollup
      // written from a partial day would stay wrong until the next refresh.
      for (let i = 1; i <= days; i++) {
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

      await populateToolDownloadSummaries(d1);
      await populateBackendToolSummaries(d1);
      await populateTrendingToolSummaries(d1);

      return {
        daysProcessed,
        mauDaysProcessed,
      };
    },
  };
}
