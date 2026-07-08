#!/usr/bin/env node
/**
 * Refresh daily_version_stats directly from GitHub Actions.
 *
 * This avoids the Worker/admin endpoint so long backfills do not hit Worker
 * invocation limits and Cloudflare API errors are visible in GHA logs.
 */

const DEFAULT_ANALYTICS_DB_ID = "21a8b89a-c2cc-4a8a-9805-b4bcfcd4f6c8";
const DEFAULT_DATASET = "mise_analytics_events";
const DEFAULT_CUTOVER_DATE = "2026-06-12";
const CLOUDFLARE_RETRY_ATTEMPTS = 3;

function usage() {
  console.error(`Usage: node scripts/refresh-version-stats-direct.js [--date=YYYY-MM-DD] [--days=N]

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
  const args = { date: null, days: 31 };
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
  const d = new Date(`${baseDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().split("T")[0];
}

function dateRange(date) {
  return {
    start: `${date} 00:00:00`,
    end: `${date} 23:59:59`,
  };
}

function timestamp(dateTime) {
  return Math.floor(new Date(`${dateTime}Z`).getTime() / 1000);
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
    const response = await fetch(url, {
      ...fetchOptions,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...fetchOptions.headers,
      },
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (response.ok && data?.success !== false) {
      return data;
    }

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

async function queryAnalyticsEngine({ accountId, token, dataset, sql }) {
  console.log(`Analytics Engine SQL:\n${sql.trim()}\n`);
  const data = await cfFetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    token,
    {
      method: "POST",
      body: `${sql}\nFORMAT JSON`,
    },
  );
  if (!Array.isArray(data.data)) {
    throw new Error(
      `Unexpected Analytics Engine response: ${JSON.stringify(data)}`,
    );
  }
  console.log(`Analytics Engine returned ${data.data.length} row(s)`);
  return data.data;
}

async function queryD1({ accountId, token, databaseId, sql, params = [] }) {
  console.log(`D1 SQL:\n${sql.trim()}\nparams: ${JSON.stringify(params)}\n`);
  const data = await cfFetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ sql, params }),
    },
  );
  const first = Array.isArray(data.result) ? data.result[0] : data.result;
  if (!first?.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(data)}`);
  }
  const rows = first.results ?? [];
  console.log(`D1 returned ${rows.length} row(s)`);
  return rows;
}

async function refreshVersionStatsFromAnalyticsEngine(config, date) {
  const { start, end } = dateRange(date);
  const rows = await queryAnalyticsEngine({
    accountId: config.analyticsEngineAccountId,
    token: config.analyticsEngineApiToken,
    dataset: config.dataset,
    sql: `
      SELECT
        sum(_sample_interval) AS total_requests,
        count(DISTINCT index1) AS unique_users
      FROM ${config.dataset}
      WHERE
        blob1 = 'version_request'
        AND timestamp >= toDateTime('${start}')
        AND timestamp <= toDateTime('${end}')
    `,
  });

  return {
    totalRequests: Number(rows[0]?.total_requests ?? 0),
    uniqueUsers: Number(rows[0]?.unique_users ?? 0),
  };
}

async function refreshVersionStatsFromD1(config, date) {
  const dateStart = timestamp(`${date} 00:00:00`);
  const dateEnd = dateStart + 86400;
  const rows = await queryD1({
    accountId: config.cloudflareAccountId,
    token: config.cloudflareApiToken,
    databaseId: config.analyticsDbId,
    sql: `
      SELECT
        COUNT(*) AS total_requests,
        COUNT(DISTINCT ip_hash) AS unique_users
      FROM version_requests
      WHERE created_at >= ? AND created_at < ?
    `,
    params: [dateStart, dateEnd],
  });

  return {
    totalRequests: Number(rows[0]?.total_requests ?? 0),
    uniqueUsers: Number(rows[0]?.unique_users ?? 0),
  };
}

async function refreshVersionStatsForDate(config, date) {
  console.log(`Refreshing version stats for ${date}`);
  const stats =
    date >= config.cutoverDate
      ? await refreshVersionStatsFromAnalyticsEngine(config, date)
      : await refreshVersionStatsFromD1(config, date);

  if (
    !Number.isFinite(stats.totalRequests) ||
    !Number.isFinite(stats.uniqueUsers)
  ) {
    throw new Error(
      `Unexpected version stats for ${date}: ${JSON.stringify(stats)}`,
    );
  }

  await queryD1({
    accountId: config.cloudflareAccountId,
    token: config.cloudflareApiToken,
    databaseId: config.analyticsDbId,
    sql: `
      INSERT OR REPLACE INTO daily_version_stats
        (date, total_requests, unique_users)
      VALUES (?, ?, ?)
    `,
    params: [date, stats.totalRequests, stats.uniqueUsers],
  });

  console.log(
    `Refreshed ${date}: ${stats.totalRequests} total request(s), ${stats.uniqueUsers} unique user(s)`,
  );
  return { date, ...stats };
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
  const dates = Array.from({ length: args.days }, (_, i) =>
    dateStrAgo(baseDate, i),
  );
  console.log(`Refreshing version stats for: ${dates.join(", ")}`);

  const results = [];
  for (const date of dates) {
    results.push(await refreshVersionStatsForDate(config, date));
  }
  console.log(JSON.stringify({ success: true, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
