#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { completedDates } from "./lib/rollup-dates.js";

/**
 * Refresh daily download rollups directly from GitHub Actions.
 *
 * Analytics Engine supplies post-cutover events and the D1 REST API stores
 * the user-visible global, tool, backend, version, and platform rollups. This
 * avoids Worker invocation limits and leaves Cloudflare failures visible in
 * Actions logs.
 */

const DEFAULT_ANALYTICS_DB_ID = "21a8b89a-c2cc-4a8a-9805-b4bcfcd4f6c8";
const DEFAULT_DATASET = "mise_analytics_events";
const DEFAULT_CUTOVER_DATE = "2026-06-12";
const CLOUDFLARE_RETRY_ATTEMPTS = 3;
const CLOUDFLARE_FETCH_TIMEOUT_MS = 30_000;
const D1_MAX_PARAMS = 100;

function usage() {
  console.error(`Usage: node scripts/refresh-download-rollups-direct.js [--date=YYYY-MM-DD] [--days=N]

  --date  Newest UTC day to refresh; defaults to yesterday and is clamped to
          yesterday, since the current UTC day is not over yet.
  --days  Number of complete days to refresh, counting back from --date.

Environment:
  CLOUDFLARE_ACCOUNT_ID       Cloudflare account id
  CLOUDFLARE_API_TOKEN        Cloudflare API token with D1 edit access
  ANALYTICS_ENGINE_ACCOUNT_ID Optional; defaults to CLOUDFLARE_ACCOUNT_ID
  ANALYTICS_ENGINE_API_TOKEN  Optional; defaults to CLOUDFLARE_API_TOKEN
  ANALYTICS_ENGINE_DATASET    Optional; defaults to ${DEFAULT_DATASET}
  ANALYTICS_ENGINE_CUTOVER_DATE Optional; defaults to ${DEFAULT_CUTOVER_DATE}
  ANALYTICS_DB_ID             Optional; defaults to production ANALYTICS_DB id
  LOGPUSH_CUTOVER_DATE        Optional; from this date on, add the Logpush
                              beacon installs (logpush_daily_* tables)
`);
}

function parseArgs(argv) {
  const args = { date: null, days: 2 };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg.startsWith("--date=")) {
      args.date = arg.slice("--date=".length);
    } else if (arg.startsWith("--days=")) {
      args.days = Number(arg.slice("--days=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error(`Invalid --date: ${args.date}`);
  }
  if (!Number.isInteger(args.days) || args.days < 1 || args.days > 31) {
    throw new Error("--days must be an integer from 1 to 31");
  }
  return args;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function dateRange(date) {
  return {
    start: `${date} 00:00:00`,
    end: `${date} 23:59:59`,
  };
}

function finiteNumber(value, label) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) {
    throw new Error(`Unexpected ${label}: ${JSON.stringify(value)}`);
  }
  return number;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableCloudflareFailure(status, data) {
  const codes = Array.isArray(data?.errors)
    ? data.errors.map((error) => error?.code)
    : [];
  return status === 429 || status >= 500 || codes.includes(7429);
}

async function cfFetch(url, token, options = {}) {
  const { retries = CLOUDFLARE_RETRY_ATTEMPTS, ...fetchOptions } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        ...fetchOptions,
        signal: AbortSignal.timeout(CLOUDFLARE_FETCH_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...fetchOptions.headers,
        },
      });
    } catch (error) {
      const message = `Cloudflare API request failed: ${error instanceof Error ? error.message : String(error)}`;
      if (attempt < retries) {
        const delay = 2 ** attempt * 1000;
        console.warn(`${message}; retrying in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw new Error(message);
    }

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (response.ok && data?.success !== false) return data;

    const message = `Cloudflare API failed ${response.status}: ${JSON.stringify(data)}`;
    if (
      attempt < retries &&
      isRetryableCloudflareFailure(response.status, data)
    ) {
      const delay = 2 ** attempt * 1000;
      console.warn(`${message}; retrying in ${delay}ms`);
      await sleep(delay);
      continue;
    }
    throw new Error(message);
  }

  throw new Error("Cloudflare API failed after retries");
}

async function queryAnalyticsEngine(config, sql) {
  const data = await cfFetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.analyticsEngineAccountId}/analytics_engine/sql`,
    config.analyticsEngineApiToken,
    { method: "POST", body: `${sql}\nFORMAT JSON` },
  );
  if (!Array.isArray(data.data)) {
    throw new Error(
      `Unexpected Analytics Engine response: ${JSON.stringify(data)}`,
    );
  }
  return data.data;
}

async function queryD1(config, sql, params = [], label = "D1 query") {
  let data;
  try {
    data = await cfFetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/d1/database/${config.analyticsDbId}/query`,
      config.cloudflareApiToken,
      { method: "POST", body: JSON.stringify({ sql, params }) },
    );
  } catch (error) {
    throw new Error(`${label} failed: ${error.message}`, { cause: error });
  }
  const first = Array.isArray(data.result) ? data.result[0] : data.result;
  if (!first?.success) {
    throw new Error(`${label} failed: ${JSON.stringify(data)}`);
  }
  return first.results ?? [];
}

async function batchUpsert(config, table, columns, rows) {
  if (rows.length === 0) return;
  const batchSize = Math.max(1, Math.floor(D1_MAX_PARAMS / columns.length));
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const placeholders = batch
      .map(() => `(${columns.map(() => "?").join(", ")})`)
      .join(", ");
    await queryD1(
      config,
      `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES ${placeholders}`,
      batch.flat(),
      `${table} batch ${Math.floor(i / batchSize) + 1}`,
    );
  }
  console.log(`Upserted ${rows.length} ${table} row(s)`);
}

function toolIdMap(rows) {
  return new Map(rows.map((row) => [row.name, Number(row.id)]));
}

function platformKey(os, arch) {
  return `${os ?? ""}\0${arch ?? ""}`;
}

function platformIdMap(rows) {
  return new Map(
    rows.map((row) => [platformKey(row.os, row.arch), Number(row.id)]),
  );
}

// Tool and platform ids for the aggregate rows. `createTools` lists tool
// names to create when missing, as the Worker's download route does at
// tracking time (getOrCreateToolId); the Logpush beacon has no such step.
async function loadDimensionIds(
  config,
  platformRows,
  { createTools = [] } = {},
) {
  const [existingTools, existingPlatforms] = await Promise.all([
    queryD1(config, "SELECT id, name FROM tools"),
    queryD1(config, "SELECT id, os, arch FROM platforms"),
  ]);
  let tools = toolIdMap(existingTools);
  let platforms = platformIdMap(existingPlatforms);

  const missingTools = [...new Set(createTools)].filter(
    (name) => name && !tools.has(name),
  );
  if (missingTools.length > 0) {
    for (let i = 0; i < missingTools.length; i += D1_MAX_PARAMS) {
      const batch = missingTools.slice(i, i + D1_MAX_PARAMS);
      await queryD1(
        config,
        `INSERT OR IGNORE INTO tools (name) VALUES ${batch.map(() => "(?)").join(", ")}`,
        batch,
        "create tools",
      );
    }
    console.log(`Created ${missingTools.length} tool row(s)`);
    tools = toolIdMap(await queryD1(config, "SELECT id, name FROM tools"));
  }

  const missing = new Map();
  for (const row of platformRows) {
    const os = row.os || null;
    const arch = row.arch || null;
    if (!os && !arch) continue;
    const key = platformKey(os, arch);
    if (!platforms.has(key)) missing.set(key, [os, arch]);
  }

  if (missing.size > 0) {
    const values = [...missing.values()];
    const batchSize = Math.floor(D1_MAX_PARAMS / 2);
    for (let i = 0; i < values.length; i += batchSize) {
      const batch = values.slice(i, i + batchSize);
      await queryD1(
        config,
        `INSERT OR IGNORE INTO platforms (os, arch) VALUES ${batch.map(() => "(?, ?)").join(", ")}`,
        batch.flat(),
        "create platforms",
      );
    }
    platforms = platformIdMap(
      await queryD1(config, "SELECT id, os, arch FROM platforms"),
    );
  }

  return { tools, platforms };
}

function resolveToolRows(rows, tools, build) {
  const result = [];
  const unknown = new Set();
  for (const row of rows) {
    const toolId = tools.get(row.tool);
    if (toolId === undefined) {
      unknown.add(row.tool);
      continue;
    }
    result.push(build(row, toolId));
  }
  if (unknown.size > 0) {
    console.warn(`Skipped unknown tools: ${[...unknown].sort().join(", ")}`);
  }
  return result;
}

// Resolve per-dimension aggregate rows (tool names, os/arch pairs) to the D1
// rollup row shapes. Shared with the Logpush shadow rollup so both sources
// produce identical tables.
function buildDimensionRows(
  date,
  ids,
  { toolRows, backendRows, toolBackendRows, versionRows, platformRows },
) {
  const dailyTools = resolveToolRows(toolRows, ids.tools, (row, toolId) => [
    date,
    toolId,
    finiteNumber(row.downloads, `${row.tool} downloads`),
    finiteNumber(row.unique_users, `${row.tool} users`),
  ]);
  const dailyBackends = backendRows.map((row) => [
    date,
    row.backend_type || "unknown",
    finiteNumber(row.downloads, `${row.backend_type} downloads`),
    finiteNumber(row.unique_users, `${row.backend_type} users`),
  ]);
  const dailyToolBackends = resolveToolRows(
    toolBackendRows,
    ids.tools,
    (row, toolId) => [
      date,
      toolId,
      row.backend_type || "unknown",
      finiteNumber(row.downloads, `${row.tool} backend downloads`),
    ],
  );
  const dailyVersions = resolveToolRows(
    versionRows.filter((row) => row.version),
    ids.tools,
    (row, toolId) => [
      date,
      toolId,
      row.version,
      finiteNumber(row.downloads, `${row.tool} version downloads`),
    ],
  );
  const dailyPlatforms = resolveToolRows(
    platformRows,
    ids.tools,
    (row, toolId) => [
      date,
      toolId,
      row.os || row.arch
        ? ids.platforms.get(platformKey(row.os || null, row.arch || null))
        : 0,
      finiteNumber(row.downloads, `${row.tool} platform downloads`),
    ],
  ).filter((row) => row[2] !== undefined);
  return {
    dailyTools,
    dailyBackends,
    dailyToolBackends,
    dailyVersions,
    dailyPlatforms,
  };
}

// Daily download tables and their key/value columns. The logpush_* shadow
// tables written by refresh-logpush-analytics-direct.js have the same shape.
const DIMENSION_TABLES = [
  ["daily_tool_stats", ["date", "tool_id"], ["downloads", "unique_users"]],
  [
    "daily_backend_stats",
    ["date", "backend_type"],
    ["downloads", "unique_users"],
  ],
  [
    "daily_tool_backend_stats",
    ["date", "tool_id", "backend_type"],
    ["downloads"],
  ],
  ["daily_tool_version_stats", ["date", "tool_id", "version"], ["downloads"]],
  [
    "daily_tool_platform_stats",
    ["date", "tool_id", "platform_id"],
    ["downloads"],
  ],
];

// From LOGPUSH_CUTOVER_DATE on, installs reported by the static /t beacon
// (counted from Logpush) are added to the Analytics Engine counts, which then
// only cover clients that still POST /api/tools/<tool>. A client sends one or
// the other, so the counts add up; unique users are summed too, which
// overcounts only a user seen through both paths on the same day.
//
// The Logpush rollup writes logpush_daily_stats only after every logpush_daily_*
// download table for the day is refilled (and deletes it before rewriting), so
// the row is the completeness marker: without it the day is missing or half
// rewritten, and this fails rather than publish partial installs.
async function loadLogpushRows(config, date) {
  const [stats] = await queryD1(
    config,
    "SELECT total_downloads, unique_users FROM logpush_daily_stats WHERE date = ?",
    [date],
    "logpush_daily_stats",
  );
  if (!stats) {
    throw new Error(
      `${date}: no logpush_daily_stats row, so the Logpush download tables are missing or incomplete; rerun the Logpush rollup first (LOGPUSH_CUTOVER_DATE=${config.logpushCutoverDate})`,
    );
  }
  const tables = {};
  for (const [table, keys, values] of DIMENSION_TABLES) {
    const columns = [...keys, ...values];
    const rows = await queryD1(
      config,
      `SELECT ${columns.join(", ")} FROM logpush_${table} WHERE date = ?`,
      [date],
      `logpush_${table}`,
    );
    tables[table] = rows.map((row) => columns.map((column) => row[column]));
  }
  return {
    totalDownloads: finiteNumber(stats.total_downloads, "logpush downloads"),
    uniqueUsers: finiteNumber(stats.unique_users, "logpush users"),
    tables,
  };
}

// Sum rows shaped [...keys, ...values] that share the same keys.
function sumRows(keyCount, ...rowSets) {
  const merged = new Map();
  for (const rows of rowSets) {
    for (const row of rows) {
      const key = JSON.stringify(row.slice(0, keyCount));
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, [...row]);
        continue;
      }
      for (let i = keyCount; i < row.length; i++) {
        existing[i] = Number(existing[i]) + Number(row[i]);
      }
    }
  }
  return [...merged.values()];
}

async function refreshDate(config, date) {
  if (date <= config.cutoverDate) {
    throw new Error(
      `${date} is not after Analytics Engine cutover ${config.cutoverDate}`,
    );
  }

  console.log(`Refreshing download rollups for ${date}`);
  const logpush =
    config.logpushCutoverDate && date >= config.logpushCutoverDate
      ? await loadLogpushRows(config, date)
      : null;
  const { start, end } = dateRange(date);
  const range = `timestamp >= toDateTime('${start}') AND timestamp <= toDateTime('${end}')`;
  const dedupedDownloads = `(
    SELECT
      index1 AS ip_hash,
      blob2 AS tool,
      blob3 AS version,
      argMax(blob4, timestamp) AS os,
      argMax(blob5, timestamp) AS arch,
      argMax(blob7, timestamp) AS backend_type,
      argMax(_sample_interval, timestamp) AS sample_weight
    FROM ${config.dataset}
    WHERE blob1 = 'download' AND ${range}
    GROUP BY index1, blob2, blob3
  )`;

  const dimensionPromise = Promise.all([
    queryAnalyticsEngine(
      config,
      `SELECT tool, sum(sample_weight) AS downloads, count(DISTINCT ip_hash) AS unique_users FROM ${dedupedDownloads} GROUP BY tool`,
    ),
    queryAnalyticsEngine(
      config,
      `SELECT backend_type, sum(sample_weight) AS downloads, count(DISTINCT ip_hash) AS unique_users FROM ${dedupedDownloads} GROUP BY backend_type`,
    ),
    queryAnalyticsEngine(
      config,
      `SELECT tool, backend_type, sum(sample_weight) AS downloads FROM ${dedupedDownloads} GROUP BY tool, backend_type`,
    ),
    queryAnalyticsEngine(
      config,
      `SELECT tool, version, sum(sample_weight) AS downloads FROM ${dedupedDownloads} GROUP BY tool, version`,
    ),
    queryAnalyticsEngine(
      config,
      `SELECT tool, os, arch, sum(sample_weight) AS downloads FROM ${dedupedDownloads} GROUP BY tool, os, arch`,
    ),
  ]).then(
    (rows) => ({ ok: true, rows }),
    (error) => ({ ok: false, error }),
  );

  const [globalRows, combinedRows] = await Promise.all([
    queryAnalyticsEngine(
      config,
      `SELECT sum(sample_weight) AS total, count(DISTINCT ip_hash) AS unique_users FROM ${dedupedDownloads}`,
    ),
    queryAnalyticsEngine(
      config,
      `SELECT count(DISTINCT index1) AS unique_users FROM ${config.dataset} WHERE blob1 IN ('download', 'version_request') AND ${range}`,
    ),
  ]);

  const totalDownloads =
    finiteNumber(globalRows[0]?.total, "total downloads") +
    (logpush?.totalDownloads ?? 0);
  const downloadUsers =
    finiteNumber(globalRows[0]?.unique_users, "download users") +
    (logpush?.uniqueUsers ?? 0);
  const combinedUsers = finiteNumber(
    combinedRows[0]?.unique_users,
    "combined users",
  );

  await Promise.all([
    batchUpsert(
      config,
      "daily_stats",
      ["date", "total_downloads", "unique_users"],
      [[date, totalDownloads, downloadUsers]],
    ),
    batchUpsert(
      config,
      "daily_combined_stats",
      ["date", "unique_users"],
      [[date, combinedUsers]],
    ),
  ]);

  const dimensions = await dimensionPromise;
  if (!dimensions.ok) throw dimensions.error;
  const [toolRows, backendRows, toolBackendRows, versionRows, platformRows] =
    dimensions.rows;
  const ids = await loadDimensionIds(config, platformRows);
  const built = buildDimensionRows(date, ids, {
    toolRows,
    backendRows,
    toolBackendRows,
    versionRows,
    platformRows,
  });
  const aeRows = {
    daily_tool_stats: built.dailyTools,
    daily_backend_stats: built.dailyBackends,
    daily_tool_backend_stats: built.dailyToolBackends,
    daily_tool_version_stats: built.dailyVersions,
    daily_tool_platform_stats: built.dailyPlatforms,
  };
  const written = {};
  for (const [table, keys, values] of DIMENSION_TABLES) {
    const rows = logpush
      ? sumRows(keys.length, aeRows[table], logpush.tables[table])
      : aeRows[table];
    await batchUpsert(config, table, [...keys, ...values], rows);
    written[table] = rows.length;
  }

  const result = {
    date,
    totalDownloads,
    combinedUsers,
    logpushDownloads: logpush?.totalDownloads ?? null,
    tools: written.daily_tool_stats,
    backends: written.daily_backend_stats,
    toolBackends: written.daily_tool_backend_stats,
    versions: written.daily_tool_version_stats,
    platforms: written.daily_tool_platform_stats,
  };
  console.log(JSON.stringify(result));
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cloudflareAccountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  const cloudflareApiToken = requiredEnv("CLOUDFLARE_API_TOKEN");
  const config = {
    cloudflareAccountId,
    cloudflareApiToken,
    analyticsEngineAccountId:
      process.env.ANALYTICS_ENGINE_ACCOUNT_ID || cloudflareAccountId,
    analyticsEngineApiToken:
      process.env.ANALYTICS_ENGINE_API_TOKEN || cloudflareApiToken,
    analyticsDbId: process.env.ANALYTICS_DB_ID || DEFAULT_ANALYTICS_DB_ID,
    dataset: process.env.ANALYTICS_ENGINE_DATASET || DEFAULT_DATASET,
    cutoverDate:
      process.env.ANALYTICS_ENGINE_CUTOVER_DATE || DEFAULT_CUTOVER_DATE,
    logpushCutoverDate: process.env.LOGPUSH_CUTOVER_DATE || null,
  };
  if (
    config.logpushCutoverDate &&
    !/^\d{4}-\d{2}-\d{2}$/.test(config.logpushCutoverDate)
  ) {
    throw new Error(
      `Invalid LOGPUSH_CUTOVER_DATE: ${config.logpushCutoverDate}`,
    );
  }

  const dates = completedDates(args.date, args.days);
  console.log(`Refreshing download rollups for: ${dates.join(", ")}`);

  const results = [];
  for (const date of dates) results.push(await refreshDate(config, date));
  console.log(JSON.stringify({ success: true, results }, null, 2));
}

export {
  batchUpsert,
  buildDimensionRows,
  loadDimensionIds,
  parseArgs,
  queryD1,
  refreshDate,
  requiredEnv,
};

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
