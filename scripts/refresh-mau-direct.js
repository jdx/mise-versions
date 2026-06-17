#!/usr/bin/env node
/**
 * Refresh daily_mau_stats directly from GitHub Actions.
 *
 * This intentionally avoids the Worker/admin endpoint so Cloudflare API errors
 * are visible in GHA logs. It queries Analytics Engine for distinct users, then
 * upserts the result with the D1 REST API.
 */

const DEFAULT_ANALYTICS_DB_ID = "21a8b89a-c2cc-4a8a-9805-b4bcfcd4f6c8";
const DEFAULT_DATASET = "mise_analytics_events";
const DEFAULT_CUTOVER_DATE = "2026-06-12";

function usage() {
  console.error(`Usage: node scripts/refresh-mau-direct.js [--date=YYYY-MM-DD] [--days=N]

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

async function cfFetch(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok || data?.success === false) {
    throw new Error(
      `Cloudflare API failed ${response.status}: ${JSON.stringify(data)}`,
    );
  }
  return data;
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

async function refreshMauForDate(config, date) {
  const cutoverDate = config.cutoverDate;
  const cutoverTs = timestamp(`${cutoverDate}T00:00:00`.replace("T", " "));
  const { end } = dateRange(date);
  const startDate = new Date(`${date}T23:59:59Z`);
  startDate.setUTCDate(startDate.getUTCDate() - 30);
  const start = startDate.toISOString().replace("T", " ").slice(0, 19);
  const startTs = Math.floor(startDate.getTime() / 1000);
  const endTs = timestamp(end);

  console.log(`Refreshing MAU for ${date} (${start} to ${end})`);

  const users = new Set();
  if (startTs < cutoverTs) {
    const d1End = Math.min(cutoverTs, endTs + 1);
    const d1Users = await queryD1({
      accountId: config.cloudflareAccountId,
      token: config.cloudflareApiToken,
      databaseId: config.analyticsDbId,
      sql: `
        SELECT DISTINCT ip_hash FROM (
          SELECT ip_hash FROM downloads WHERE created_at >= ? AND created_at < ?
          UNION
          SELECT ip_hash FROM version_requests WHERE created_at >= ? AND created_at < ?
        )
      `,
      params: [startTs, d1End, startTs, d1End],
    });
    for (const row of d1Users) users.add(row.ip_hash);
  }

  if (endTs >= cutoverTs) {
    const aeStart = new Date(Math.max(startTs, cutoverTs) * 1000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    const aeUsers = await queryAnalyticsEngine({
      accountId: config.analyticsEngineAccountId,
      token: config.analyticsEngineApiToken,
      dataset: config.dataset,
      sql: `
        SELECT DISTINCT index1 AS ip_hash
        FROM ${config.dataset}
        WHERE
          blob1 IN ('download', 'version_request')
          AND timestamp >= toDateTime('${aeStart}')
          AND timestamp <= toDateTime('${end}')
      `,
    });
    for (const row of aeUsers) users.add(row.ip_hash);
  }

  if (users.size <= 0) {
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
    params: [date, users.size],
  });

  console.log(`Refreshed ${date}: ${users.size} MAU`);
  return { date, mau: users.size };
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
