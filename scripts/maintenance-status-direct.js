#!/usr/bin/env node
/**
 * Print maintenance/rollup status directly from Cloudflare D1.
 *
 * This is intended for GitHub Actions workflow_dispatch runs where we already
 * have Cloudflare API credentials, avoiding the Worker admin API_SECRET.
 */

const DEFAULT_ANALYTICS_DB_ID = "21a8b89a-c2cc-4a8a-9805-b4bcfcd4f6c8";
const CLOUDFLARE_RETRY_ATTEMPTS = 3;

function usage() {
  console.error(`Usage: node scripts/maintenance-status-direct.js

Environment:
  CLOUDFLARE_ACCOUNT_ID  Cloudflare account id
  CLOUDFLARE_API_TOKEN   Cloudflare API token with D1 read access
  ANALYTICS_DB_ID        Optional; defaults to production ANALYTICS_DB id
`);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
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

async function queryD1({ accountId, token, databaseId, sql, params = [] }) {
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
  return first.results ?? [];
}

function isoFromTs(ts) {
  return ts === null || ts === undefined
    ? null
    : new Date(Number(ts) * 1000).toISOString();
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage();
    return;
  }

  const config = {
    accountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
    token: requiredEnv("CLOUDFLARE_API_TOKEN"),
    databaseId: process.env.ANALYTICS_DB_ID || DEFAULT_ANALYTICS_DB_ID,
  };

  const [rollups] = await queryD1({
    ...config,
    sql: `
      SELECT
        (SELECT MAX(date) FROM daily_stats) AS daily_stats,
        (SELECT MAX(date) FROM daily_tool_stats) AS daily_tool_stats,
        (SELECT MAX(date) FROM daily_backend_stats) AS daily_backend_stats,
        (SELECT MAX(date) FROM daily_tool_backend_stats) AS daily_tool_backend_stats,
        (SELECT MAX(date) FROM daily_tool_version_stats) AS daily_tool_version_stats,
        (SELECT MAX(date) FROM daily_tool_platform_stats) AS daily_tool_platform_stats,
        (SELECT MAX(date) FROM daily_mau_stats) AS daily_mau_stats,
        (SELECT MAX(date) FROM daily_combined_stats) AS daily_combined_stats,
        (SELECT MAX(date) FROM daily_version_stats) AS daily_version_stats
    `,
  });

  const latestMauRows = await queryD1({
    ...config,
    sql: `
      SELECT date, mau
      FROM daily_mau_stats
      ORDER BY date DESC
      LIMIT 15
    `,
  });

  const [downloads] = await queryD1({
    ...config,
    sql: `
      SELECT
        MIN(created_at) AS oldest_ts,
        MAX(created_at) AS latest_ts,
        COUNT(*) AS rows
      FROM downloads
    `,
  });

  const [versionRequests] = await queryD1({
    ...config,
    sql: `
      SELECT
        MIN(created_at) AS oldest_ts,
        MAX(created_at) AS latest_ts,
        COUNT(*) AS rows
      FROM version_requests
    `,
  });

  const result = {
    rollups,
    latest_mau_rows: latestMauRows,
    downloads: {
      rows: downloads?.rows ?? 0,
      oldest_ts: downloads?.oldest_ts ?? null,
      oldest_iso: isoFromTs(downloads?.oldest_ts),
      latest_ts: downloads?.latest_ts ?? null,
      latest_iso: isoFromTs(downloads?.latest_ts),
    },
    version_requests: {
      rows: versionRequests?.rows ?? 0,
      oldest_ts: versionRequests?.oldest_ts ?? null,
      oldest_iso: isoFromTs(versionRequests?.oldest_ts),
      latest_ts: versionRequests?.latest_ts ?? null,
      latest_iso: isoFromTs(versionRequests?.latest_ts),
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
