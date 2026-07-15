#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

Environment:
  CLOUDFLARE_ACCOUNT_ID       Cloudflare account id
  CLOUDFLARE_API_TOKEN        Cloudflare API token with D1 edit access
  ANALYTICS_ENGINE_ACCOUNT_ID Optional; defaults to CLOUDFLARE_ACCOUNT_ID
  ANALYTICS_ENGINE_API_TOKEN  Optional; defaults to CLOUDFLARE_API_TOKEN
  ANALYTICS_ENGINE_DATASET    Optional; defaults to ${DEFAULT_DATASET}
  ANALYTICS_ENGINE_CUTOVER_DATE Optional; defaults to ${DEFAULT_CUTOVER_DATE}
  ANALYTICS_DB_ID             Optional; defaults to production ANALYTICS_DB id
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

function dateStrAgo(baseDate, daysAgo) {
  const date = new Date(`${baseDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().split("T")[0];
}

function dateRange(date) {
  return {
    start: `${date} 00:00:00`,
    end: `${date} 23:59:59`,
  };
}

function orderedDates(baseDate, days) {
  const offsets =
    days > 1
      ? [1, 0, ...Array.from({ length: days - 2 }, (_, i) => i + 2)]
      : [0];
  return offsets.map((offset) => dateStrAgo(baseDate, offset));
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
  const data = await cfFetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/d1/database/${config.analyticsDbId}/query`,
    config.cloudflareApiToken,
    { method: "POST", body: JSON.stringify({ sql, params }) },
  );
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

async function loadDimensionIds(config, platformRows) {
  const [tools, existingPlatforms] = await Promise.all([
    queryD1(config, "SELECT id, name FROM tools"),
    queryD1(config, "SELECT id, os, arch FROM platforms"),
  ]);
  let platforms = platformIdMap(existingPlatforms);

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

  return { tools: toolIdMap(tools), platforms };
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

async function refreshDate(config, date) {
  if (date <= config.cutoverDate) {
    throw new Error(
      `${date} is not after Analytics Engine cutover ${config.cutoverDate}`,
    );
  }

  console.log(`Refreshing download rollups for ${date}`);
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

  const totalDownloads = finiteNumber(globalRows[0]?.total, "total downloads");
  const downloadUsers = finiteNumber(
    globalRows[0]?.unique_users,
    "download users",
  );
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

  await batchUpsert(
    config,
    "daily_tool_stats",
    ["date", "tool_id", "downloads", "unique_users"],
    dailyTools,
  );
  await batchUpsert(
    config,
    "daily_backend_stats",
    ["date", "backend_type", "downloads", "unique_users"],
    dailyBackends,
  );
  await batchUpsert(
    config,
    "daily_tool_backend_stats",
    ["date", "tool_id", "backend_type", "downloads"],
    dailyToolBackends,
  );
  await batchUpsert(
    config,
    "daily_tool_version_stats",
    ["date", "tool_id", "version", "downloads"],
    dailyVersions,
  );
  await batchUpsert(
    config,
    "daily_tool_platform_stats",
    ["date", "tool_id", "platform_id", "downloads"],
    dailyPlatforms,
  );

  const result = {
    date,
    totalDownloads,
    combinedUsers,
    tools: dailyTools.length,
    backends: dailyBackends.length,
    toolBackends: dailyToolBackends.length,
    versions: dailyVersions.length,
    platforms: dailyPlatforms.length,
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
  };

  const baseDate = args.date || new Date().toISOString().split("T")[0];
  const dates = orderedDates(baseDate, args.days);
  console.log(`Refreshing download rollups for: ${dates.join(", ")}`);

  const results = [];
  for (const date of dates) results.push(await refreshDate(config, date));
  console.log(JSON.stringify({ success: true, results }, null, 2));
}

export { batchUpsert, orderedDates, parseArgs, refreshDate };

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
