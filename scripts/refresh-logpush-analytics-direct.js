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
 * The site reads logpush_daily_dau/_mau for DAU/MAU (falling back to the
 * Analytics Engine rollups for older dates), and refresh-download-rollups-
 * direct.js adds the download tables into daily_* from LOGPUSH_CUTOVER_DATE.
 *
 * Each day's distinct users are also written to R2 as an exact sorted hash
 * set (see lib/user-hash-set.js), so MAU unions 30 small files instead of
 * re-reading 30 days of raw logs.
 *
 * Retention (mise-logs bucket lifecycle, by prefix): raw logs under
 * `http_requests/` expire after 35 days, so a day can be re-read from logs for
 * about a month; the per-day user sets under `rollups/` are kept 400 days, so
 * MAU for any day in the last year can be recomputed from them.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import {
  completedDates,
  dateStrAgo,
  lastCompleteUtcDate,
} from "./lib/rollup-dates.js";
import {
  DEFAULT_BEACON_HOSTS,
  LogpushDayAggregator,
  logpushDayPrefixes,
  objectOverlapsDate,
} from "./lib/logpush.js";
import { reportGithubVersionsDemand } from "./lib/github-versions-demand.js";
import {
  capacityLimitsFromEnv,
  jobStartedAtMs,
  peakRssBytes,
  reportCapacity,
} from "./lib/logpush-capacity.js";
import {
  DEFAULT_MISE_RELEASE_ZONES,
  MiseReleaseDayAggregator,
  dayCoverage,
  writeMiseReleaseDownloads,
} from "./lib/mise-release-downloads.js";
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
  LOGPUSH_RELEASE_ZONES         Optional comma list of zones to count mise release
                                downloads in; defaults to ${DEFAULT_MISE_RELEASE_ZONES.join(",")}
  ANALYTICS_DB_ID               Optional; defaults to production ANALYTICS_DB id

Capacity warnings (see lib/logpush-capacity.js; warnings never fail the run):
  LOGPUSH_TIMEOUT_MINUTES          The job's timeout-minutes; enables the runtime check
  LOGPUSH_HEAP_LIMIT_MB            The --max-old-space-size value; enables the memory check
  LOGPUSH_JOB_STARTED_AT           Job start in unix seconds; defaults to process start
  LOGPUSH_CAPACITY_RUNTIME_RATIO   Warn above this share of the timeout; default 0.5
  LOGPUSH_CAPACITY_RSS_RATIO       Warn when peak RSS passes this share of the heap limit; default 0.5
  LOGPUSH_CAPACITY_MAX_DAY_LINES   Warn when a day has more log lines; default 100000000
  RESEND_API_KEY                   Emails a warning through Resend; without it, only annotations
  CAPACITY_ALERT_TO                Alert recipient; defaults to DIGEST_TO, then the digest's default
  DIGEST_TO, DIGEST_FROM           The daily digest's recipient and sender, reused for the alert
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
// because R2 stored them with Content-Encoding: gzip. Returns the number of
// uncompressed bytes read.
export async function forEachLine(buffer, onLine) {
  const gzipped =
    buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const source = Readable.from([buffer]);
  const stream = gzipped ? source.pipe(createGunzip()) : source;
  const decoder = new StringDecoder("utf8");
  let bytes = 0;
  let rest = "";
  for await (const chunk of stream) {
    bytes += chunk.length;
    const text = rest + decoder.write(chunk);
    let start = 0;
    let newline;
    while ((newline = text.indexOf("\n", start)) !== -1) {
      onLine(text.slice(start, newline));
      start = newline + 1;
    }
    rest = text.slice(start);
  }
  rest += decoder.end();
  if (rest) onLine(rest);
  return bytes;
}

// Each object is tagged with its zone, since the mise usage numbers and the
// release download counts read different zones.
async function listDayObjects(config, date) {
  const objects = [];
  for (const zone of new Set([...config.zones, ...releaseZones(config)])) {
    for (const { folderDate, prefix } of logpushDayPrefixes(
      config.prefix,
      zone,
      date,
    )) {
      const listed = await config.r2.listObjects(prefix);
      for (const object of listed) {
        if (objectOverlapsDate(object.key, folderDate, date)) {
          objects.push({ ...object, zone });
        }
      }
    }
  }
  return objects;
}

function releaseZones(config) {
  return config.releaseZones ?? DEFAULT_MISE_RELEASE_ZONES;
}

async function readDay(config, date, objects, releases) {
  const aggregator = new LogpushDayAggregator({
    date,
    secret: config.ipHashSecret,
    hosts: config.hosts,
    beaconHosts: config.beaconHosts,
  });
  let next = 0;
  let done = 0;
  let bytes = 0;
  let uncompressedBytes = 0;
  let lines = 0;
  const worker = async () => {
    while (next < objects.length) {
      const object = objects[next++];
      const buffer = await config.r2.getObject(object.key);
      if (!buffer) throw new Error(`Log object disappeared: ${object.key}`);
      bytes += buffer.length;
      const usage = config.zones.includes(object.zone);
      const release = releaseZones(config).includes(object.zone);
      // Await into a local first: `total += await ...` would read the total
      // before the await and drop what other workers added meanwhile.
      const objectBytes = await forEachLine(buffer, (line) => {
        lines++;
        if (usage) aggregator.addLine(line);
        if (release) releases.addLine(line);
      });
      uncompressedBytes += objectBytes;
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
  return {
    aggregator,
    read: {
      objects: objects.length,
      compressedBytes: bytes,
      uncompressedBytes,
      lines,
    },
  };
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

// Write a day's MAU row unless the stored row was computed from more user sets.
// A window only gains sets over time (a backfill adds one); fewer than before
// means files went missing, and a rewrite would replace a complete count with
// a partial one, so the stored row is kept. Dry runs write nothing and may
// have no D1 token, so they skip the check too. Returns whether the row was
// (or, in a dry run, would be) written.
async function writeMau(config, date, mau, updatedAt) {
  if (config.dryRun) return true;
  const [existing] = await queryD1(
    config,
    "SELECT days_covered FROM logpush_daily_mau WHERE date = ?",
    [date],
    "logpush_daily_mau read",
  );
  if (existing && mau.daysCovered < Number(existing.days_covered)) {
    console.warn(
      `${date}: keeping stored MAU (${existing.days_covered} days covered); only ${mau.daysCovered} user sets are available now`,
    );
    return false;
  }
  await batchUpsert(
    config,
    "logpush_daily_mau",
    ["date", "mau", "days_covered", "updated_at"],
    [[date, mau.mau, mau.daysCovered, updatedAt]],
  );
  return true;
}

// Each day's user set feeds the MAU of the 29 days after it, so refreshing a
// day (a backfill, or a repaired day) also changes those days' MAU. The
// completed days after the refreshed ones, up to `lastDate`, that have a user
// set of their own (and so a logpush_daily_mau row) and were not refreshed in
// this run.
export function laterMauDates(refreshedDates, lastDate) {
  const refreshed = new Set(refreshedDates);
  const dates = new Set();
  for (const date of refreshedDates) {
    for (let i = 1; i < MAU_WINDOW_DAYS; i++) {
      const later = dateStrAgo(date, -i);
      if (later > lastDate) break;
      if (!refreshed.has(later)) dates.add(later);
    }
  }
  return [...dates].sort();
}

export async function recomputeLaterMau(
  config,
  refreshedDates,
  userSets,
  lastDate = lastCompleteUtcDate(),
) {
  const updatedAt = new Date().toISOString();
  const results = [];
  for (const date of laterMauDates(refreshedDates, lastDate)) {
    if (!(await loadUserSet(config, date, userSets))) continue;
    const mau = await trailingMau(date, (day) =>
      loadUserSet(config, day, userSets),
    );
    if (!(await writeMau(config, date, mau, updatedAt))) continue;
    results.push({ date, mau: mau.mau, mauDaysCovered: mau.daysCovered });
  }
  if (results.length > 0) {
    console.log(`Recomputed MAU for later days: ${JSON.stringify(results)}`);
  }
  return results;
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
  await writeMau(config, date, mau, updatedAt);

  // logpush_daily_stats marks a day's download tables as complete: drop it
  // before rewriting them and write it back only once all are refilled, so a
  // run that fails part way leaves no marker and readers fail closed.
  const rollups = aggregator.downloadRollups();
  await queryD1(
    config,
    "DELETE FROM logpush_daily_stats WHERE date = ?",
    [date],
    "logpush_daily_stats clear",
  );
  const ids = await loadDimensionIds(config, rollups.platforms, {
    createTools: rollups.tools.map((row) => row.tool),
  });
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
  await batchUpsert(
    config,
    "logpush_daily_stats",
    ["date", "total_downloads", "unique_users"],
    [[date, rollups.total, rollups.uniqueUsers]],
  );
  return rollups;
}

// A day's release download counts are only marked covered when every release
// zone's logs span the whole day; see dayCoverage().
function miseReleaseResult(config, date, objects, releases) {
  const coverage = dayCoverage(objects, releaseZones(config), date);
  if (!coverage.complete) {
    console.warn(
      `${date}: Logpush objects do not cover the whole day in every release zone, so mise release downloads are stored but not marked covered: ${JSON.stringify(coverage.zones)}`,
    );
  }
  return {
    complete: coverage.complete,
    ...releases.stats,
    versions: releases.versions.size,
  };
}

// The mise usage numbers for a day: the user set, DAU, MAU and beacon
// installs. Writes nothing in a dry run.
async function refreshUsage(config, date, aggregator, userSets, started) {
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
  result.githubVersionsPaths = aggregator.githubVersionsPaths.size;
  if (!config.dryRun && config.apiSecret) {
    try {
      result.githubVersionsDemand = await reportGithubVersionsDemand({
        apiUrl: config.demandApiUrl,
        secret: config.apiSecret,
        date,
        paths: [...aggregator.githubVersionsPaths],
      });
    } catch (error) {
      // Demand only decides what the next deploys bake; never fail the
      // rollup over it.
      console.warn(`${date}: reporting GitHub versions demand failed:`, error);
    }
  }
  return result;
}

// A day with objects only in release zones (such as en.dev) still gets its
// release download counts, but no usage numbers: writing them would store an
// empty user set and zero DAU for a day whose usage logs are missing.
export async function refreshDate(config, date, userSets) {
  const objects = await listDayObjects(config, date);
  if (objects.length === 0) {
    console.warn(
      `${date}: no Logpush objects under ${config.prefix}/{${[...new Set([...config.zones, ...releaseZones(config)])].join(",")}}; skipping`,
    );
    return { date, skipped: true };
  }
  const hasUsage = objects.some((object) => config.zones.includes(object.zone));
  console.log(`${date}: reading ${objects.length} Logpush object(s)`);
  const started = Date.now();
  const releases = new MiseReleaseDayAggregator({ date });
  const { aggregator, read } = await readDay(config, date, objects, releases);
  const capacity = { date, readMs: Date.now() - started, ...read };

  let result = { date };
  if (hasUsage) {
    result = {
      ...result,
      ...(await refreshUsage(config, date, aggregator, userSets, started)),
    };
  } else {
    console.warn(
      `${date}: no Logpush objects under ${config.prefix}/{${config.zones.join(",")}}; counting mise release downloads only`,
    );
    result.usageSkipped = true;
  }
  result.miseReleases = miseReleaseResult(config, date, objects, releases);
  if (!config.dryRun) {
    await writeMiseReleaseDownloads(
      config,
      date,
      releases,
      result.miseReleases.complete,
      new Date().toISOString(),
    );
  }
  result.capacity = capacity;
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
    releaseZones: listEnv("LOGPUSH_RELEASE_ZONES", DEFAULT_MISE_RELEASE_ZONES),
    hosts: listEnv("LOGPUSH_HOSTS", null),
    beaconHosts: listEnv("LOGPUSH_BEACON_HOSTS", DEFAULT_BEACON_HOSTS),
    statePrefix: (
      process.env.LOGPUSH_STATE_PREFIX || DEFAULT_STATE_PREFIX
    ).replace(/\/+$/, ""),
    dryRun: args.dryRun,
    // The Worker's API_SECRET, for reporting GitHub versions demand.
    apiSecret: process.env.API_SECRET,
    demandApiUrl: process.env.DEMAND_API_URL || "https://mise-versions.jdx.dev",
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
  let outcome = { ok: true };
  try {
    await runRollup(config, dates, userSets, results);
  } catch (error) {
    outcome = { ok: false, error: String(error?.message ?? error) };
    throw error;
  } finally {
    // After all rollup work, so runtime and memory cover it, and also on
    // failure, so a run that dies part way still records the days it
    // finished. Never throws.
    await reportCapacity(
      {
        jobElapsedMs: Date.now() - jobStartedAtMs(),
        peakRssBytes: peakRssBytes(),
        days: results.filter((r) => r.capacity).map((r) => r.capacity),
      },
      capacityLimitsFromEnv(),
      { email: !config.dryRun, outcome },
    );
  }
}

async function runRollup(config, dates, userSets, results) {
  for (const date of dates) {
    results.push(await refreshDate(config, date, userSets));
  }
  const refreshed = results
    .filter((result) => !result.skipped && !result.usageSkipped)
    .map((result) => result.date);
  const recomputedMau = await recomputeLaterMau(config, refreshed, userSets);
  console.log(
    JSON.stringify({ success: true, results, recomputedMau }, null, 2),
  );
  if (results.every((result) => result.skipped || result.usageSkipped)) {
    throw new Error(
      "No Logpush objects found in the usage zones (LOGPUSH_ZONES) for any requested date; check the bucket, prefix, zones, and credentials",
    );
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
