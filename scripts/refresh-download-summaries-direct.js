#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  batchUpsert,
  queryD1,
  requiredEnv,
} from "./refresh-download-rollups-direct.js";

/**
 * Rebuild the download summary tables directly from GitHub Actions.
 *
 * Tool pages, the tool list, the backends page, and the trending section read
 * these summaries instead of scanning the daily rollups. They are derived from
 * daily_tool_*_stats (plus pre-rollup raw/aggregated downloads), so this runs
 * after refresh-download-rollups-direct.js. Summaries are rebuilt in tool id
 * ranges to keep each D1 statement well inside the query time limit.
 */

const DEFAULT_ANALYTICS_DB_ID = "21a8b89a-c2cc-4a8a-9805-b4bcfcd4f6c8";
const TOOL_CHUNK_SIZE = 100;
const TRENDING_LOOKBACK_DAYS = 30;
const TRENDING_SPARKLINE_DAYS = 13; // yesterday through 13 days ago; today is incomplete.
const TRENDING_MIN_DOWNLOADS = 500;

function usage() {
  console.error(`Usage: node scripts/refresh-download-summaries-direct.js

Environment:
  CLOUDFLARE_ACCOUNT_ID  Cloudflare account id
  CLOUDFLARE_API_TOKEN   Cloudflare API token with D1 edit access
  ANALYTICS_DB_ID        Optional; defaults to production ANALYTICS_DB id
`);
}

function dateStr(seconds) {
  return new Date(seconds * 1000).toISOString().split("T")[0];
}

export function toolIdRanges(ids, size = TOOL_CHUNK_SIZE) {
  const sorted = [...ids].sort((a, b) => a - b);
  const ranges = [];
  for (let i = 0; i < sorted.length; i += size) {
    const chunk = sorted.slice(i, i + size);
    ranges.push([chunk[0], chunk[chunk.length - 1]]);
  }
  return ranges;
}

// ?1/?2 bound the tool id range; ?3 is the 30-day cutoff; ?4 is updated_at.
const TOOL_SUMMARIES_SQL = `
  INSERT OR REPLACE INTO tool_download_summaries (
    tool_id,
    downloads_30d,
    downloads_all_time,
    updated_at
  )
  WITH all_time AS (
    SELECT tool_id, SUM(downloads) AS downloads_all_time
    FROM (
      SELECT tool_id, SUM(downloads) AS downloads
      FROM daily_tool_stats
      WHERE tool_id BETWEEN ?1 AND ?2
      GROUP BY tool_id
      UNION ALL
      SELECT d.tool_id, COUNT(*) AS downloads
      FROM downloads d
      LEFT JOIN daily_tool_stats s
        ON s.tool_id = d.tool_id
        AND s.date = date(d.created_at, 'unixepoch')
      WHERE d.tool_id BETWEEN ?1 AND ?2 AND s.tool_id IS NULL
      GROUP BY d.tool_id
      UNION ALL
      SELECT dd.tool_id, SUM(dd.count) AS downloads
      FROM downloads_daily dd
      LEFT JOIN daily_tool_stats s
        ON s.tool_id = dd.tool_id
        AND s.date = dd.date
      WHERE dd.tool_id BETWEEN ?1 AND ?2 AND s.tool_id IS NULL
      GROUP BY dd.tool_id
    )
    GROUP BY tool_id
  ),
  recent AS (
    SELECT tool_id, SUM(downloads) AS downloads_30d
    FROM daily_tool_stats
    WHERE tool_id BETWEEN ?1 AND ?2 AND date >= ?3
    GROUP BY tool_id
  )
  SELECT
    t.id,
    COALESCE(r.downloads_30d, 0),
    COALESCE(a.downloads_all_time, 0),
    ?4
  FROM tools t
  LEFT JOIN all_time a ON a.tool_id = t.id
  LEFT JOIN recent r ON r.tool_id = t.id
  WHERE t.id BETWEEN ?1 AND ?2
`;

const PLATFORM_SUMMARIES_SQL = `
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
    SELECT tool_id, platform_id, SUM(downloads) AS downloads
    FROM daily_tool_platform_stats
    WHERE tool_id BETWEEN ?1 AND ?2
    GROUP BY tool_id, platform_id
    UNION ALL
    SELECT d.tool_id, d.platform_id, COUNT(*) AS downloads
    FROM downloads d
    LEFT JOIN daily_tool_platform_stats s
      ON s.tool_id = d.tool_id
      AND s.platform_id = COALESCE(d.platform_id, 0)
      AND s.date = date(d.created_at, 'unixepoch')
    WHERE d.tool_id BETWEEN ?1 AND ?2 AND s.tool_id IS NULL
    GROUP BY d.tool_id, d.platform_id
    UNION ALL
    SELECT dd.tool_id, dd.platform_id, SUM(dd.count) AS downloads
    FROM downloads_daily dd
    LEFT JOIN daily_tool_platform_stats s
      ON s.tool_id = dd.tool_id
      AND s.platform_id = COALESCE(dd.platform_id, 0)
      AND s.date = dd.date
    WHERE dd.tool_id BETWEEN ?1 AND ?2 AND s.tool_id IS NULL
    GROUP BY dd.tool_id, dd.platform_id
  )
  GROUP BY tool_id, COALESCE(platform_id, 0)
`;

const VERSION_SUMMARIES_SQL = `
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
    SELECT tool_id, version, SUM(downloads) AS downloads
    FROM daily_tool_version_stats
    WHERE tool_id BETWEEN ?1 AND ?2
    GROUP BY tool_id, version
    UNION ALL
    SELECT d.tool_id, d.version, COUNT(*) AS downloads
    FROM downloads d
    LEFT JOIN daily_tool_version_stats s
      ON s.tool_id = d.tool_id
      AND s.version = d.version
      AND s.date = date(d.created_at, 'unixepoch')
    WHERE d.tool_id BETWEEN ?1 AND ?2 AND s.tool_id IS NULL
    GROUP BY d.tool_id, d.version
    UNION ALL
    SELECT dd.tool_id, dd.version, SUM(dd.count) AS downloads
    FROM downloads_daily dd
    LEFT JOIN daily_tool_version_stats s
      ON s.tool_id = dd.tool_id
      AND s.version = dd.version
      AND s.date = dd.date
    WHERE dd.tool_id BETWEEN ?1 AND ?2 AND s.tool_id IS NULL
    GROUP BY dd.tool_id, dd.version
  )
  GROUP BY tool_id, version
`;

export async function refreshToolSummaries(config, now) {
  const thirtyDaysAgo = dateStr(now - 30 * 86400);
  const updatedAt = new Date(now * 1000).toISOString();
  const tools = await queryD1(config, "SELECT id FROM tools", [], "tool ids");
  const ranges = toolIdRanges(tools.map((row) => Number(row.id)));

  for (const [first, last] of ranges) {
    const label = `tools ${first}..${last}`;
    await queryD1(
      config,
      TOOL_SUMMARIES_SQL,
      [first, last, thirtyDaysAgo, updatedAt],
      `tool_download_summaries ${label}`,
    );
    await queryD1(
      config,
      PLATFORM_SUMMARIES_SQL,
      [first, last],
      `tool_platform_download_summaries ${label}`,
    );
    await queryD1(
      config,
      VERSION_SUMMARIES_SQL,
      [first, last],
      `tool_version_download_summaries ${label}`,
    );
    console.log(`Refreshed download summaries for ${label}`);
  }

  return { tools: tools.length, chunks: ranges.length };
}

export async function refreshBackendSummaries(config, now) {
  const updatedAt = new Date(now * 1000).toISOString();
  await queryD1(
    config,
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
    "backend_tool_summaries",
  );

  const [refreshed] = await queryD1(
    config,
    "SELECT COUNT(*) AS count FROM backend_tool_summaries WHERE updated_at = ?",
    [updatedAt],
    "count backend_tool_summaries",
  );
  const count = Number(refreshed?.count ?? 0);
  if (count > 0) {
    await queryD1(
      config,
      "DELETE FROM backend_tool_summaries WHERE updated_at != ?",
      [updatedAt],
      "prune backend_tool_summaries",
    );
  }
  return { backends: count };
}

// Mirrors populateTrendingToolSummaries in src/analytics/rollups.ts.
export function trendingRows(dailyData, now) {
  const lookupDates = Array.from({ length: TRENDING_LOOKBACK_DAYS }, (_, i) =>
    dateStr(now - (i + 1) * 86400),
  );
  const sparklineDates = lookupDates
    .slice(0, TRENDING_SPARKLINE_DAYS)
    .reverse();

  const toolData = new Map();
  for (const row of dailyData) {
    const toolId = Number(row.tool_id);
    if (!toolData.has(toolId)) {
      toolData.set(toolId, {
        total: Number(row.downloads_30d),
        daily: new Map(),
      });
    }
    toolData.get(toolId).daily.set(row.date, Number(row.downloads));
  }

  const rows = [];
  for (const [toolId, data] of toolData) {
    const dailyValues = lookupDates.map((date) => data.daily.get(date) ?? 0);
    const mean =
      dailyValues.reduce((sum, value) => sum + value, 0) / dailyValues.length;
    const variance =
      dailyValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      dailyValues.length;
    const stddev = Math.sqrt(variance);
    if (stddev === 0) continue;

    const recentAvg = (dailyValues[0] + dailyValues[1] + dailyValues[2]) / 3;
    const dailyBoost = (recentAvg - mean) / stddev;
    const sparkline = sparklineDates.map((date) => data.daily.get(date) ?? 0);
    rows.push({
      toolId,
      downloads30d: data.total,
      dailyBoost,
      sparkline: JSON.stringify(sparkline),
    });
  }
  return rows;
}

export async function refreshTrendingSummaries(config, now) {
  const thirtyDaysAgo = dateStr(now - TRENDING_LOOKBACK_DAYS * 86400);
  const today = dateStr(now);
  const updatedAt = new Date(now * 1000).toISOString();

  const dailyData = await queryD1(
    config,
    `
      WITH candidates AS (
        SELECT
          daily_tool_stats.tool_id,
          SUM(daily_tool_stats.downloads) AS downloads_30d
        FROM daily_tool_stats
          INNER JOIN tools ON daily_tool_stats.tool_id = tools.id
        WHERE
          daily_tool_stats.date >= ?1
          AND daily_tool_stats.date < ?2
          AND tools.latest_version IS NOT NULL
        GROUP BY daily_tool_stats.tool_id
        HAVING SUM(daily_tool_stats.downloads) >= ?3
      )
      SELECT
        daily_tool_stats.tool_id,
        candidates.downloads_30d,
        daily_tool_stats.date,
        daily_tool_stats.downloads
      FROM daily_tool_stats
        INNER JOIN candidates ON daily_tool_stats.tool_id = candidates.tool_id
      WHERE
        daily_tool_stats.date >= ?1
        AND daily_tool_stats.date < ?2
      ORDER BY daily_tool_stats.date
    `,
    [thirtyDaysAgo, today, TRENDING_MIN_DOWNLOADS],
    "trending candidates",
  );

  const rows = trendingRows(dailyData, now);
  await batchUpsert(
    config,
    "trending_tool_summaries",
    [
      "tool_id",
      "downloads_30d",
      "daily_boost",
      "trending_score",
      "sparkline",
      "updated_at",
    ],
    // trending_score is kept separate so the ranking formula can evolve
    // without a schema change.
    rows.map((row) => [
      row.toolId,
      row.downloads30d,
      row.dailyBoost,
      row.dailyBoost,
      row.sparkline,
      updatedAt,
    ]),
  );
  if (rows.length > 0) {
    await queryD1(
      config,
      "DELETE FROM trending_tool_summaries WHERE updated_at != ?",
      [updatedAt],
      "prune trending_tool_summaries",
    );
  }
  return { trending: rows.length };
}

export async function refreshSummaries(config, now = Date.now() / 1000) {
  const seconds = Math.floor(now);
  const results = {
    ...(await refreshToolSummaries(config, seconds)),
    ...(await refreshBackendSummaries(config, seconds)),
    ...(await refreshTrendingSummaries(config, seconds)),
  };
  console.log(JSON.stringify(results));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  if (args.length > 0) throw new Error(`Unknown argument: ${args[0]}`);

  const config = {
    cloudflareAccountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
    cloudflareApiToken: requiredEnv("CLOUDFLARE_API_TOKEN"),
    analyticsDbId: process.env.ANALYTICS_DB_ID || DEFAULT_ANALYTICS_DB_ID,
  };
  const results = await refreshSummaries(config);
  console.log(JSON.stringify({ success: true, results }, null, 2));
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
