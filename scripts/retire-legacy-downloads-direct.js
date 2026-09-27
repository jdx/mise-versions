#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { queryD1, requiredEnv } from "./refresh-download-rollups-direct.js";

/**
 * Retire the pre-Analytics Engine raw download tables.
 *
 * `downloads`, `downloads_daily`, and `version_requests` stopped receiving rows
 * at the Analytics Engine cutover. Days that never got a daily rollup row still
 * depend on them, so:
 *
 *   --mode=fold    copy those days into the daily rollups: per-tool,
 *                  per-version, and per-platform downloads from raw and
 *                  archived rows, and daily_stats, daily_combined_stats, and
 *                  daily_version_stats from raw rows; fills missing rows only,
 *                  so it is safe to re-run
 *   --mode=verify  report any legacy rows still missing from those rollups
 *   --mode=drop    verify, then delete the legacy tables; refuses while
 *                  anything is missing, and resumes if interrupted
 *
 * Days from the cutover on are never folded: part of their events went to
 * Analytics Engine, so the legacy rows alone would undercount them, and those
 * rollups cannot be rebuilt once the legacy rows are gone. If one is missing,
 * drop refuses unless --allow-cutover-gaps accepts losing those rows.
 *
 * Run drop only after the code that no longer reads these tables is deployed.
 */

const DEFAULT_ANALYTICS_DB_ID = "21a8b89a-c2cc-4a8a-9805-b4bcfcd4f6c8";
const DEFAULT_CUTOVER_DATE = "2026-06-12";
const LEGACY_TABLES = ["downloads", "downloads_daily", "version_requests"];
const DELETE_BATCH_ROWS = 100_000;
const MODES = ["fold", "verify", "drop"];

function usage() {
  console.error(`Usage: node scripts/retire-legacy-downloads-direct.js --mode=${MODES.join("|")} [--allow-cutover-gaps]

  --allow-cutover-gaps  With --mode=drop, drop even if rollups for days from
                        the cutover on are missing legacy rows; those rows are
                        lost.

Environment:
  CLOUDFLARE_ACCOUNT_ID  Cloudflare account id
  CLOUDFLARE_API_TOKEN   Cloudflare API token with D1 edit access
  ANALYTICS_DB_ID        Optional; defaults to production ANALYTICS_DB id
  ANALYTICS_ENGINE_CUTOVER_DATE Optional; defaults to ${DEFAULT_CUTOVER_DATE}
`);
}

export function parseArgs(argv) {
  let mode = null;
  let allowCutoverGaps = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
    } else if (arg === "--allow-cutover-gaps") {
      allowCutoverGaps = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!MODES.includes(mode)) {
    throw new Error(`--mode must be one of: ${MODES.join(", ")}`);
  }
  if (allowCutoverGaps && mode !== "drop") {
    throw new Error("--allow-cutover-gaps only applies to --mode=drop");
  }
  return { mode, allowCutoverGaps };
}

function dayStart(date) {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
}

function dateStr(seconds) {
  return new Date(seconds * 1000).toISOString().split("T")[0];
}

async function existingTables(config) {
  const rows = await queryD1(
    config,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${LEGACY_TABLES.map(() => "?").join(", ")})`,
    LEGACY_TABLES,
    "legacy tables",
  );
  return new Set(rows.map((row) => row.name));
}

async function createdAtDates(config, table, dates) {
  const [range] = await queryD1(
    config,
    `SELECT MIN(created_at) AS oldest, MAX(created_at) AS latest FROM ${table}`,
    [],
    `${table} range`,
  );
  if (range?.oldest == null) return;
  const last = dateStr(Number(range.latest));
  for (
    let date = dateStr(Number(range.oldest));
    date <= last;
    date = dateStr(dayStart(date) + 86400)
  ) {
    dates.add(date);
  }
}

// Every UTC day that has raw, archived, or version-request rows.
export async function legacyDates(config, tables) {
  const dates = new Set();
  for (const table of ["downloads", "version_requests"]) {
    if (tables.has(table)) await createdAtDates(config, table, dates);
  }
  if (tables.has("downloads_daily")) {
    const rows = await queryD1(
      config,
      "SELECT DISTINCT date FROM downloads_daily",
      [],
      "downloads_daily dates",
    );
    for (const row of rows) dates.add(row.date);
  }
  return [...dates].sort();
}

// For one day, the SELECT that yields each rollup's missing rows. ?1 is the
// date; the day's created_at bounds are inlined because SQLite rejects binding
// a parameter the statement does not use, and which sources appear depends on
// which legacy tables still exist. Per-tool keys match the way the old all-time
// summaries counted legacy rows: only when the rollup had no row for that key.
function folds(tables, date) {
  const start = dayStart(date);
  const createdAt = `created_at >= ${start} AND created_at < ${start + 86400}`;
  const raw = tables.has("downloads");
  const archived = tables.has("downloads_daily");
  const requests = tables.has("version_requests");
  const union = (...parts) => parts.filter(Boolean).join(" UNION ALL ");

  const perTool = (table, key, sums, rawSql, archivedSql) => {
    const source = union(raw && rawSql, archived && archivedSql);
    const covered = key
      .split(", ")
      .map((column) => `s.${column} = src.${column}`)
      .join(" AND ");
    return {
      table,
      columns: `date, ${key}, ${sums.join(", ")}`,
      select:
        source &&
        `SELECT ?1, ${key}, ${sums.map((sum) => `SUM(${sum})`).join(", ")}
         FROM (${source}) src
         WHERE NOT EXISTS (
           SELECT 1 FROM ${table} s WHERE s.date = ?1 AND ${covered}
         )
         GROUP BY ${key}`,
    };
  };

  // `source` yields one row of totals for the day; skip days with no events.
  const perDay = (table, columns, source) => ({
    table,
    columns: `date, ${columns.join(", ")}`,
    select:
      source &&
      `SELECT ?1, ${columns.join(", ")}
       FROM (${source})
       WHERE ${columns[0]} > 0
         AND NOT EXISTS (SELECT 1 FROM ${table} WHERE date = ?1)`,
  });

  const dailyUsers = union(
    raw && `SELECT ip_hash FROM downloads WHERE ${createdAt}`,
    requests && `SELECT ip_hash FROM version_requests WHERE ${createdAt}`,
  );

  return [
    perTool(
      "daily_tool_stats",
      "tool_id",
      ["downloads", "unique_users"],
      `SELECT tool_id, COUNT(*) AS downloads, COUNT(DISTINCT ip_hash) AS unique_users
       FROM downloads WHERE ${createdAt} GROUP BY tool_id`,
      // Archived rows lost their ip hashes; summing per-group unique ips is
      // the best available unique_users estimate.
      `SELECT tool_id, SUM(count) AS downloads, SUM(unique_ips) AS unique_users
       FROM downloads_daily WHERE date = ?1 GROUP BY tool_id`,
    ),
    perTool(
      "daily_tool_version_stats",
      "tool_id, version",
      ["downloads"],
      `SELECT tool_id, version, COUNT(*) AS downloads
       FROM downloads WHERE ${createdAt} GROUP BY tool_id, version`,
      `SELECT tool_id, version, SUM(count) AS downloads
       FROM downloads_daily WHERE date = ?1 GROUP BY tool_id, version`,
    ),
    perTool(
      "daily_tool_platform_stats",
      "tool_id, platform_id",
      ["downloads"],
      `SELECT tool_id, COALESCE(platform_id, 0) AS platform_id, COUNT(*) AS downloads
       FROM downloads WHERE ${createdAt} GROUP BY tool_id, COALESCE(platform_id, 0)`,
      `SELECT tool_id, COALESCE(platform_id, 0) AS platform_id, SUM(count) AS downloads
       FROM downloads_daily WHERE date = ?1 GROUP BY tool_id, COALESCE(platform_id, 0)`,
    ),
    // Global rollups come from raw rows only: archived per-group unique ips
    // cannot be combined into a daily unique-user count.
    perDay(
      "daily_stats",
      ["total_downloads", "unique_users"],
      raw &&
        `SELECT COUNT(*) AS total_downloads, COUNT(DISTINCT ip_hash) AS unique_users
         FROM downloads WHERE ${createdAt}`,
    ),
    perDay(
      "daily_combined_stats",
      ["unique_users"],
      dailyUsers &&
        `SELECT COUNT(DISTINCT ip_hash) AS unique_users FROM (${dailyUsers})`,
    ),
    perDay(
      "daily_version_stats",
      ["total_requests", "unique_users"],
      requests &&
        `SELECT COUNT(*) AS total_requests, COUNT(DISTINCT ip_hash) AS unique_users
         FROM version_requests WHERE ${createdAt}`,
    ),
  ].filter((rollup) => rollup.select);
}

export async function fold(config) {
  const tables = await existingTables(config);
  const dates = await legacyDates(config, tables);
  console.log(`Folding ${dates.length} legacy day(s)`);
  for (const date of dates) {
    // From the cutover day on, part of the events went to Analytics Engine,
    // so the legacy rows alone would undercount. Those rollups must already
    // exist; verify reports them if they do not.
    if (date >= config.cutoverDate) {
      console.log(`Skipping ${date}: not before cutover ${config.cutoverDate}`);
      continue;
    }
    for (const rollup of folds(tables, date)) {
      await queryD1(
        config,
        `INSERT INTO ${rollup.table} (${rollup.columns}) ${rollup.select}`,
        [date],
        `fold ${rollup.table} ${date}`,
      );
    }
    console.log(`Folded ${date}`);
  }
  return { days: dates.length };
}

// Returns legacy rows still missing from the rollups, per table and day.
// `missing` can be fixed by fold; `cutoverGaps` (days from the cutover on)
// cannot.
export async function verify(config) {
  const tables = await existingTables(config);
  const dates = await legacyDates(config, tables);
  const missing = [];
  const cutoverGaps = [];
  for (const date of dates) {
    for (const rollup of folds(tables, date)) {
      const [row] = await queryD1(
        config,
        `SELECT COUNT(*) AS count FROM (${rollup.select})`,
        [date],
        `verify ${rollup.table} ${date}`,
      );
      const count = Number(row?.count ?? 0);
      if (count === 0) continue;
      const gap = { table: rollup.table, date, rows: count };
      (date >= config.cutoverDate ? cutoverGaps : missing).push(gap);
    }
  }
  if (missing.length === 0 && cutoverGaps.length === 0) {
    console.log(
      `All ${dates.length} legacy day(s) are covered by the daily rollups`,
    );
  }
  if (missing.length > 0) {
    console.log(`Missing from rollups (run fold): ${JSON.stringify(missing)}`);
  }
  if (cutoverGaps.length > 0) {
    console.log(
      `Missing from cutover-day rollups (cannot be folded): ${JSON.stringify(cutoverGaps)}`,
    );
  }
  return { days: dates.length, missing, cutoverGaps };
}

async function deleteTable(config, table) {
  // Drop secondary indexes first so the batched deletes don't have to
  // maintain them, then delete by rowid range so no single statement has to
  // free the whole table.
  const indexes = await queryD1(
    config,
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
    [table],
    `${table} indexes`,
  );
  for (const { name } of indexes) {
    await queryD1(config, `DROP INDEX IF EXISTS "${name}"`, [], `drop ${name}`);
  }

  const [range] = await queryD1(
    config,
    `SELECT MIN(rowid) AS first, MAX(rowid) AS last FROM ${table}`,
    [],
    `${table} rowids`,
  );
  if (range?.first != null) {
    for (
      let start = Number(range.first);
      start <= Number(range.last);
      start += DELETE_BATCH_ROWS
    ) {
      await queryD1(
        config,
        `DELETE FROM ${table} WHERE rowid >= ? AND rowid < ?`,
        [start, start + DELETE_BATCH_ROWS],
        `delete ${table} from rowid ${start}`,
      );
    }
  }
  await queryD1(config, `DROP TABLE IF EXISTS ${table}`, [], `drop ${table}`);
  console.log(`Dropped ${table}`);
}

export async function drop(config, { allowCutoverGaps = false } = {}) {
  const { missing, cutoverGaps } = await verify(config);
  if (missing.length > 0) {
    throw new Error(
      "Refusing to drop legacy tables while rollups are missing legacy rows; run --mode=fold first",
    );
  }
  if (cutoverGaps.length > 0 && !allowCutoverGaps) {
    throw new Error(
      "Refusing to drop legacy tables while cutover-day rollups are missing legacy rows; pass --allow-cutover-gaps to drop them anyway",
    );
  }
  const tables = await existingTables(config);
  for (const table of LEGACY_TABLES) {
    if (tables.has(table)) await deleteTable(config, table);
  }
  return { dropped: LEGACY_TABLES.filter((table) => tables.has(table)) };
}

async function main() {
  const { mode, allowCutoverGaps } = parseArgs(process.argv.slice(2));
  const config = {
    cloudflareAccountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
    cloudflareApiToken: requiredEnv("CLOUDFLARE_API_TOKEN"),
    analyticsDbId: process.env.ANALYTICS_DB_ID || DEFAULT_ANALYTICS_DB_ID,
    cutoverDate:
      process.env.ANALYTICS_ENGINE_CUTOVER_DATE || DEFAULT_CUTOVER_DATE,
  };
  const result = await { fold, verify, drop }[mode](config, {
    allowCutoverGaps,
  });
  console.log(JSON.stringify({ success: true, mode, result }, null, 2));
  if (
    mode === "verify" &&
    (result.missing.length > 0 || result.cutoverGaps.length > 0)
  ) {
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
