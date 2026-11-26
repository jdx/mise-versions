#!/usr/bin/env node
/**
 * Compare tool lookups (logpush_daily_tool_lookups) with beacon installs
 * (logpush_daily_tool_stats) over a date range, to judge whether lookups can
 * stand in for install counts on the site's graphs.
 *
 * Both sides count distinct non-CI machines per tool per day. Lookups are
 * restricted to mise releases that send the beacon (beacon_client_users), so
 * the two cover the same clients. Prints, for the tools with the most
 * installs, the average daily machines each way and their ratio, plus the
 * Spearman rank correlation of the two over those tools: 1 means lookups rank
 * tools exactly as installs do.
 *
 * Usage: node scripts/compare-tool-lookups.js [--days=N] [--top=N] [--json]
 *
 * Environment: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and optionally
 * ANALYTICS_DB_ID (defaults to production).
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { queryD1, requiredEnv } from "./refresh-download-rollups-direct.js";

const DEFAULT_ANALYTICS_DB_ID = "21a8b89a-c2cc-4a8a-9805-b4bcfcd4f6c8";

/** Spearman rank correlation of two equal-length number lists. */
export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const ranks = (values) => {
    const order = values
      .map((value, index) => ({ value, index }))
      .sort((a, b) => b.value - a.value);
    const result = new Array(n);
    for (let i = 0; i < n;) {
      let j = i;
      while (j + 1 < n && order[j + 1].value === order[i].value) j++;
      // Ties share the average of their ranks.
      for (let k = i; k <= j; k++) result[order[k].index] = (i + j) / 2;
      i = j + 1;
    }
    return result;
  };
  const rx = ranks(xs);
  const ry = ranks(ys);
  const mean = (n - 1) / 2;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (rx[i] - mean) * (ry[i] - mean);
    vx += (rx[i] - mean) ** 2;
    vy += (ry[i] - mean) ** 2;
  }
  return vx === 0 || vy === 0 ? null : cov / Math.sqrt(vx * vy);
}

/**
 * The comparison for the `top` tools by installs. `installs` and `lookups`
 * are rows of { tool, users } summed over `days` complete days.
 */
export function compareLookups({ installs, lookups, days, top }) {
  const lookupUsers = new Map(lookups.map((row) => [row.tool, row.users]));
  const rows = [...installs]
    .sort((a, b) => b.users - a.users || a.tool.localeCompare(b.tool))
    .slice(0, top)
    .map((row) => {
      const looked = lookupUsers.get(row.tool) ?? 0;
      return {
        tool: row.tool,
        installsPerDay: row.users / days,
        lookupsPerDay: looked / days,
        ratio: row.users > 0 ? looked / row.users : null,
      };
    });
  return {
    days,
    tools: rows.length,
    spearman: spearman(
      rows.map((row) => row.installsPerDay),
      rows.map((row) => row.lookupsPerDay),
    ),
    rows,
  };
}

function parseArgs(argv) {
  const args = { days: 28, top: 50, json: false };
  for (const arg of argv) {
    if (arg.startsWith("--days=")) args.days = Number(arg.slice(7));
    else if (arg.startsWith("--top=")) args.top = Number(arg.slice(6));
    else if (arg === "--json") args.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.days) || args.days < 1) {
    throw new Error("--days must be a positive integer");
  }
  if (!Number.isInteger(args.top) || args.top < 2) {
    throw new Error("--top must be an integer of at least 2");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = {
    cloudflareAccountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
    cloudflareApiToken: requiredEnv("CLOUDFLARE_API_TOKEN"),
    analyticsDbId: process.env.ANALYTICS_DB_ID || DEFAULT_ANALYTICS_DB_ID,
  };
  // The newest days that are complete on both sides.
  const dates = (
    await queryD1(
      config,
      `SELECT l.date AS date FROM logpush_daily_lookup_stats l
       JOIN logpush_daily_stats s ON s.date = l.date
       ORDER BY l.date DESC LIMIT ?`,
      [args.days],
      "complete dates",
    )
  ).map((row) => row.date);
  if (dates.length === 0) {
    throw new Error("No day has both lookups and beacon installs yet");
  }
  const placeholders = dates.map(() => "?").join(", ");
  const [installs, lookups] = await Promise.all([
    queryD1(
      config,
      `SELECT t.name AS tool, SUM(s.unique_users) AS users
       FROM logpush_daily_tool_stats s JOIN tools t ON t.id = s.tool_id
       WHERE s.date IN (${placeholders}) GROUP BY t.name`,
      dates,
      "beacon installs",
    ),
    queryD1(
      config,
      `SELECT t.name AS tool, SUM(l.beacon_client_users) AS users
       FROM logpush_daily_tool_lookups l JOIN tools t ON t.id = l.tool_id
       WHERE l.date IN (${placeholders}) GROUP BY t.name`,
      dates,
      "lookups",
    ),
  ]);
  const report = compareLookups({
    installs: installs.map((row) => ({
      tool: row.tool,
      users: Number(row.users),
    })),
    lookups: lookups.map((row) => ({
      tool: row.tool,
      users: Number(row.users),
    })),
    days: dates.length,
    top: args.top,
  });
  report.from = dates[dates.length - 1];
  report.to = dates[0];
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    `${report.from}..${report.to} (${report.days} days), top ${report.tools} tools by installs`,
  );
  console.log(
    `Spearman rank correlation: ${report.spearman?.toFixed(3) ?? "n/a"}`,
  );
  console.log("tool\tinstalls/day\tlookups/day\tlookups per install");
  for (const row of report.rows) {
    console.log(
      `${row.tool}\t${row.installsPerDay.toFixed(0)}\t${row.lookupsPerDay.toFixed(0)}\t${row.ratio?.toFixed(2) ?? "-"}`,
    );
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
