#!/usr/bin/env node
/**
 * Roll Cloudflare Logpush `http_requests` logs up into shadow D1 tables.
 *
 * mise clients from v2026.6.6 read versions from static assets, which never
 * invoke the Worker and so never reach Analytics Engine. Logpush records every
 * request to the zone, static or not, so this counts every mise client:
 *
 * - logpush_daily_dau: distinct non-CI mise users per UTC day
 * - logpush_daily_mau: distinct non-CI mise users over the trailing 30 days
 * - logpush_daily_*stats: install counts from the static `/t` beacon, shaped
 *   like the Analytics Engine daily_* download rollups
 *
 * These tables are written alongside the current numbers for comparison; the
 * site does not read them yet.
 *
 * Each day's distinct users are also written to R2 as an exact sorted hash
 * set (see lib/user-hash-set.js), so MAU unions 30 small files instead of
 * re-reading 30 days of raw logs.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { completedDates, dateStrAgo } from "./lib/rollup-dates.js";
import {
  DEFAULT_BEACON_HOSTS,
  LogpushDayAggregator,
  logpushDayPrefixes,
  objectOverlapsDate,
} from "./lib/logpush.js";
import { R2Client } from "./lib/r2-s3.js";
import {
  decodeUserHashes,
  encodeUserHashes,
  unionSize,
} from "./lib/user-hash-set.js";
import {
  batchUpsert,
  buildDimensionRows,
  loadDimensionIds,
  queryD1,
  requiredEnv,
} from "./refresh-download-rollups-direct.js";

const DEFAULT_ANALYTICS_DB_ID = "21a8b89a-c2cc-4a8a-9805-b4bcfcd4f6c8";
const DEFAULT_BUCKET = "mise-logs";
const DEFAULT_PREFIX = "http_requests";
const DEFAULT_ZONES = "jdx.dev";
const DEFAULT_STATE_PREFIX = "rollups/mise-users/v1";
const MAU_WINDOW_DAYS = 30;
const DOWNLOAD_CONCURRENCY = 8;

function usage() {
  console.error(`Usage: node scripts/refresh-logpush-analytics-direct.js [--date=YYYY-MM-DD] [--days=N] [--dry-run]

  --date     Newest UTC day to refresh; defaults to yesterday and is clamped to
             yesterday, since the current UTC day is not over yet.
  --days     Number of complete days to refresh, counting back from --date.
             Days are processed oldest first so each day's MAU can use the
             user sets written for the days before it.
  --dry-run  Read logs and print results without writing to R2 or D1.

Environment:
  CLOUDFLARE_ACCOUNT_ID         Cloudflare account id
  CLOUDFLARE_API_TOKEN          Cloudflare API token with D1 edit access
  LOGPUSH_R2_ACCESS_KEY_ID      R2 S3 access key (Object Read & Write on the bucket)
  LOGPUSH_R2_SECRET_ACCESS_KEY  R2 S3 secret key
  IP_HASH_SECRET                The Worker's API_SECRET, so user hashes match
                                Analytics Engine index1
  LOGPUSH_R2_ACCOUNT_ID         Optional; defaults to CLOUDFLARE_ACCOUNT_ID
  LOGPUSH_BUCKET                Optional; defaults to ${DEFAULT_BUCKET}
  LOGPUSH_PREFIX                Optional; defaults to ${DEFAULT_PREFIX}
  LOGPUSH_ZONES                 Optional comma list; defaults to ${DEFAULT_ZONES}
  LOGPUSH_HOSTS                 Optional comma list of hosts to count; defaults to all
  LOGPUSH_BEACON_HOSTS          Optional comma list; defaults to ${DEFAULT_BEACON_HOSTS.join(",")}
  LOGPUSH_STATE_PREFIX          Optional; defaults to ${DEFAULT_STATE_PREFIX}
  ANALYTICS_DB_ID               Optional; defaults to production ANALYTICS_DB id
`);
}

export function parseArgs(argv) {
  const args = { date: null, days: 2, dryRun: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg.startsWith("--date=")) {
      args.date = arg.slice("--date=".length);
    } else if (arg.startsWith("--days=")) {
      args.days = Number(arg.slice("--days=".length));
    } else if (arg === "--dry-run") {
      args.dryRun = true;
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

function listEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const list = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
}

// Feed each line of an object to `onLine`. Logpush writes gzip'd NDJSON; the
// magic-byte check also accepts objects a client already decompressed
// because R2 stored them with Content-Encoding: gzip.
export async function forEachLine(buffer, onLine) {
  const gzipped =
    buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const source = Readable.from([buffer]);
  const stream = gzipped ? source.pipe(createGunzip()) : source;
  stream.setEncoding("utf8");
  let rest = "";
  for await (const chunk of stream) {
    const text = rest + chunk;
    let start = 0;
    let newline;
    while ((newline = text.indexOf("\n", start)) !== -1) {
      onLine(text.slice(start, newline));
      start = newline + 1;
    }
    rest = text.slice(start);
  }
  if (rest) onLine(rest);
}

async function listDayObjects(config, date) {
  const objects = [];
  for (const zone of config.zones) {
    for (const { folderDate, prefix } of logpushDayPrefixes(
      config.prefix,
      zone,
      date,
    )) {
      const listed = await config.r2.listObjects(prefix);
      for (const object of listed) {
        if (objectOverlapsDate(object.key, folderDate, date)) {
          objects.push(object);
        }
      }
    }
  }
  return objects;
}

async function readDay(config, date, objects) {
  const aggregator = new LogpushDayAggregator({
    date,
    secret: config.ipHashSecret,
    hosts: config.hosts,
    beaconHosts: config.beaconHosts,
  });
  let next = 0;
  let done = 0;
  let bytes = 0;
  const worker = async () => {
    while (next < objects.length) {
      const object = objects[next++];
      const buffer = await config.r2.getObject(object.key);
      if (!buffer) throw new Error(`Log object disappeared: ${object.key}`);
      bytes += buffer.length;
      await forEachLine(buffer, (line) => aggregator.addLine(line));
      done++;
      if (done % 50 === 0 || done === objects.length) {
        console.log(
          `${date}: read ${done}/${objects.length} objects (${(bytes / 1e6).toFixed(1)} MB)`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, objects.length) }, () =>
      worker(),
    ),
  );
  return aggregator;
}

function userSetKey(config, date) {
  return `${config.statePrefix}/${date}.bin.gz`;
}

async function loadUserSet(config, date, cache) {
  if (cache.has(date)) return cache.get(date);
  const buffer = await config.r2.getObject(userSetKey(config, date));
  const set = buffer ? decodeUserHashes(buffer) : null;
  cache.set(date, set);
  return set;
}

// Trailing 30 days ending at `date`, inclusive, like the Analytics Engine MAU
// window. Missing days (before Logpush started, or a skipped day) are
// reported through daysCovered rather than failing.
export async function trailingMau(date, loadSet) {
  const sets = [];
  for (let i = 0; i < MAU_WINDOW_DAYS; i++) {
    const set = await loadSet(dateStrAgo(date, i));
    if (set) sets.push(set);
  }
  return { mau: unionSize(sets), daysCovered: sets.length };
}

async function replaceDateRows(config, table, columns, date, rows) {
  await queryD1(
    config,
    `DELETE FROM ${table} WHERE date = ?`,
    [date],
    `${table} clear`,
  );
  await batchUpsert(config, table, columns, rows);
}

async function writeD1(config, date, aggregator, mau, updatedAt) {
  const { stats } = aggregator;
  const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());
  await batchUpsert(
    config,
    "logpush_daily_dau",
    [
      "date",
      "unique_users",
      "mise_requests",
      "ci_requests",
      "log_lines",
      "first_event_at",
      "last_event_at",
      "updated_at",
    ],
    [
      [
        date,
        aggregator.users.size,
        stats.miseRequests,
        stats.ciRequests,
        stats.lines,
        iso(stats.firstEventMs),
        iso(stats.lastEventMs),
        updatedAt,
      ],
    ],
  );
  await batchUpsert(
    config,
    "logpush_daily_mau",
    ["date", "mau", "days_covered", "updated_at"],
    [[date, mau.mau, mau.daysCovered, updatedAt]],
  );

  const rollups = aggregator.downloadRollups();
  await batchUpsert(
    config,
    "logpush_daily_stats",
    ["date", "total_downloads", "unique_users"],
    [[date, rollups.total, rollups.uniqueUsers]],
  );
  const ids = await loadDimensionIds(config, rollups.platforms);
  const rows = buildDimensionRows(date, ids, {
    toolRows: rollups.tools,
    backendRows: rollups.backends,
    toolBackendRows: rollups.toolBackends,
    versionRows: rollups.versions,
    platformRows: rollups.platforms,
  });
  await replaceDateRows(
    config,
    "logpush_daily_tool_stats",
    ["date", "tool_id", "downloads", "unique_users"],
    date,
    rows.dailyTools,
  );
  await replaceDateRows(
    config,
    "logpush_daily_backend_stats",
    ["date", "backend_type", "downloads", "unique_users"],
    date,
    rows.dailyBackends,
  );
  await replaceDateRows(
    config,
    "logpush_daily_tool_backend_stats",
    ["date", "tool_id", "backend_type", "downloads"],
    date,
    rows.dailyToolBackends,
  );
  await replaceDateRows(
    config,
    "logpush_daily_tool_version_stats",
    ["date", "tool_id", "version", "downloads"],
    date,
    rows.dailyVersions,
  );
  await replaceDateRows(
    config,
    "logpush_daily_tool_platform_stats",
    ["date", "tool_id", "platform_id", "downloads"],
    date,
    rows.dailyPlatforms,
  );
  return rollups;
}

export async function refreshDate(config, date, userSets) {
  const objects = await listDayObjects(config, date);
  if (objects.length === 0) {
    console.warn(
      `${date}: no Logpush objects under ${config.prefix}/{${config.zones.join(",")}}; skipping`,
    );
    return { date, skipped: true };
  }
  console.log(`${date}: reading ${objects.length} Logpush object(s)`);
  const started = Date.now();
  const aggregator = await readDay(config, date, objects);
  const hashes = aggregator.userHashes();
  userSets.set(date, hashes);
  const { stats } = aggregator;
  console.log(
    `${date}: ${stats.lines} lines, ${stats.inDay} mise requests in day, ${hashes.length} users, ${aggregator.downloads.size} deduped downloads in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  if (stats.malformed > 0) {
    console.warn(`${date}: skipped ${stats.malformed} malformed line(s)`);
  }
  if (stats.firstEventMs !== null) {
    // A day that starts late or ends early means Logpush coverage is partial.
    const first = new Date(stats.firstEventMs).toISOString();
    const last = new Date(stats.lastEventMs).toISOString();
    console.log(`${date}: mise requests span ${first} to ${last}`);
  }

  if (!config.dryRun) {
    await config.r2.putObject(
      userSetKey(config, date),
      encodeUserHashes(hashes),
      "application/octet-stream",
    );
  }
  const mau = await trailingMau(date, (day) =>
    loadUserSet(config, day, userSets),
  );
  if (mau.daysCovered < MAU_WINDOW_DAYS) {
    console.warn(
      `${date}: MAU covers ${mau.daysCovered}/${MAU_WINDOW_DAYS} days of Logpush data`,
    );
  }

  const result = {
    date,
    dau: hashes.length,
    mau: mau.mau,
    mauDaysCovered: mau.daysCovered,
    miseRequests: stats.miseRequests,
    ciRequests: stats.ciRequests,
    beaconRequests: stats.beaconRequests,
    downloads: aggregator.downloads.size,
  };
  if (config.dryRun) {
    const rollups = aggregator.downloadRollups();
    result.topTools = rollups.tools
      .sort((a, b) => b.downloads - a.downloads)
      .slice(0, 10)
      .map(({ tool, downloads }) => ({ tool, downloads }));
  } else {
    await writeD1(config, date, aggregator, mau, new Date().toISOString());
  }
  console.log(JSON.stringify(result));
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cloudflareAccountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  const config = {
    cloudflareAccountId,
    cloudflareApiToken: args.dryRun
      ? process.env.CLOUDFLARE_API_TOKEN
      : requiredEnv("CLOUDFLARE_API_TOKEN"),
    analyticsDbId: process.env.ANALYTICS_DB_ID || DEFAULT_ANALYTICS_DB_ID,
    ipHashSecret: requiredEnv("IP_HASH_SECRET"),
    prefix: process.env.LOGPUSH_PREFIX || DEFAULT_PREFIX,
    zones: listEnv("LOGPUSH_ZONES", DEFAULT_ZONES.split(",")),
    hosts: listEnv("LOGPUSH_HOSTS", null),
    beaconHosts: listEnv("LOGPUSH_BEACON_HOSTS", DEFAULT_BEACON_HOSTS),
    statePrefix: (
      process.env.LOGPUSH_STATE_PREFIX || DEFAULT_STATE_PREFIX
    ).replace(/\/+$/, ""),
    dryRun: args.dryRun,
    r2: new R2Client({
      accountId: process.env.LOGPUSH_R2_ACCOUNT_ID || cloudflareAccountId,
      accessKeyId: requiredEnv("LOGPUSH_R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("LOGPUSH_R2_SECRET_ACCESS_KEY"),
      bucket: process.env.LOGPUSH_BUCKET || DEFAULT_BUCKET,
    }),
  };

  // Oldest first, so a backfill writes each day's user set before the next
  // day's MAU needs it.
  const dates = completedDates(args.date, args.days).reverse();
  console.log(`Refreshing Logpush analytics for: ${dates.join(", ")}`);

  const userSets = new Map();
  const results = [];
  for (const date of dates) {
    results.push(await refreshDate(config, date, userSets));
  }
  console.log(JSON.stringify({ success: true, results }, null, 2));
  if (results.every((result) => result.skipped)) {
    throw new Error(
      "No Logpush objects found for any requested date; check the bucket, prefix, zones, and credentials",
    );
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
