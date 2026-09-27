#!/usr/bin/env node
/**
 * Refresh daily_mau_stats directly from GitHub Actions.
 *
 * This intentionally avoids the Worker/admin endpoint so Cloudflare API errors
 * are visible in GHA logs. It queries Analytics Engine for distinct users, then
 * upserts the result with the D1 REST API.
 */

import { completedDates } from "./lib/rollup-dates.js";

const DEFAULT_ANALYTICS_DB_ID = "21a8b89a-c2cc-4a8a-9805-b4bcfcd4f6c8";
const DEFAULT_DATASET = "mise_analytics_events";
const DEFAULT_CUTOVER_DATE = "2026-06-12";
const CLOUDFLARE_RETRY_ATTEMPTS = 3;

function usage() {
  console.error(`Usage: node scripts/refresh-mau-direct.js [--date=YYYY-MM-DD] [--days=N]

  --date  Newest UTC day to refresh; defaults to yesterday and is clamped to
          yesterday, since the current UTC day is not over yet.
  --days  Number of complete days to refresh, counting back from --date.

Every refreshed date's trailing 30-day window must start on or after
ANALYTICS_ENGINE_CUTOVER_DATE; earlier windows needed the retired raw D1 tables.

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

function dateRange(date) {
  return {
    start: `${date} 00:00:00`,
    end: `${date} 23:59:59`,
  };
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

async function countMauFromAnalyticsEngine(config, start, end) {
  const rows = await queryAnalyticsEngine({
    accountId: config.analyticsEngineAccountId,
    token: config.analyticsEngineApiToken,
    dataset: config.dataset,
    sql: `
      SELECT count(DISTINCT index1) AS mau
      FROM ${config.dataset}
      WHERE
        blob1 IN ('download', 'version_request')
        AND timestamp >= toDateTime('${start}')
        AND timestamp <= toDateTime('${end}')
    `,
  });
  const mau = Number(rows[0]?.mau ?? 0);
  if (!Number.isFinite(mau)) {
    throw new Error(
      `Unexpected Analytics Engine MAU result: ${JSON.stringify(rows)}`,
    );
  }
  return mau;
}

async function refreshMauForDate(config, date) {
  const { end } = dateRange(date);
  const startDate = new Date(`${date}T23:59:59Z`);
  startDate.setUTCDate(startDate.getUTCDate() - 30);
  const start = startDate.toISOString().replace("T", " ").slice(0, 19);

  // Pre-cutover events lived in D1 tables that have been retired, so a window
  // reaching back before the cutover can no longer be counted completely.
  if (start.slice(0, 10) < config.cutoverDate) {
    throw new Error(
      `${date}: 30-day MAU window starts ${start}, before Analytics Engine cutover ${config.cutoverDate}`,
    );
  }

  console.log(`Refreshing MAU for ${date} (${start} to ${end})`);

  const mau = await countMauFromAnalyticsEngine(config, start, end);

  if (mau <= 0) {
    throw new Error(`Refusing to write zero MAU for ${date}`);
  }

  await queryD1({
    accountId: config.cloudflareAccountId,
    token: config.cloudflareApiToken,
    databaseId: config.analyticsDbId,
    sql: `
      INSERT OR REPLACE INTO daily_mau_stats (date, mau)
      VALUES (?, ?)
    `,
    params: [date, mau],
  });

  console.log(`Refreshed ${date}: ${mau} MAU`);
  return { date, mau };
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

  const dates = completedDates(args.date, args.days);
  console.log(`Refreshing MAU for: ${dates.join(", ")}`);

  const results = [];
  for (const date of dates) {
    results.push(await refreshMauForDate(config, date));
  }
  console.log(JSON.stringify({ success: true, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
