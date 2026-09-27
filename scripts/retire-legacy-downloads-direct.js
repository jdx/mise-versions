#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { queryD1, requiredEnv } from "./refresh-download-rollups-direct.js";

/**
 * Retire the pre-Analytics Engine raw download tables.
 *
 * `downloads`, `downloads_daily`, and `version_requests` stopped receiving rows
 * at the Analytics Engine cutover. The only numbers still derived from them are
 * per-tool all-time totals for days that never got a daily rollup row, so:
 *
 *   --mode=fold    copy those days into daily_tool_stats,
 *                  daily_tool_version_stats, and daily_tool_platform_stats
 *                  (fills missing rows only, so it is safe to re-run)
 *   --mode=verify  report any legacy rows still missing from those rollups
 *   --mode=drop    verify, then delete the legacy tables; refuses while
 *                  anything is missing, and resumes if interrupted
 *
 * Run drop only after the code that no longer reads these tables is deployed.
 */

const DEFAULT_ANALYTICS_DB_ID = "21a8b89a-c2cc-4a8a-9805-b4bcfcd4f6c8";
const LEGACY_TABLES = ["downloads", "downloads_daily", "version_requests"];
const DELETE_BATCH_ROWS = 250_000;
const MODES = ["fold", "verify", "drop"];

function usage() {
  console.error(`Usage: node scripts/retire-legacy-downloads-direct.js --mode=${MODES.join("|")}

Environment:
  CLOUDFLARE_ACCOUNT_ID  Cloudflare account id
  CLOUDFLARE_API_TOKEN   Cloudflare API token with D1 edit access
  ANALYTICS_DB_ID        Optional; defaults to production ANALYTICS_DB id
`);
}

export function parseArgs(argv) {
  let mode = null;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!MODES.includes(mode)) {
    throw new Error(`--mode must be one of: ${MODES.join(", ")}`);
  }
  return { mode };
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

// Every UTC day that has raw or archived download rows.
export async function legacyDates(config, tables) {
  const dates = new Set();
  if (tables.has("downloads")) {
    const [range] = await queryD1(
      config,
      "SELECT MIN(created_at) AS oldest, MAX(created_at) AS latest FROM downloads",
      [],
      "downloads range",
    );
    if (range?.oldest != null) {
      const last = dateStr(Number(range.latest));
      for (
        let date = dateStr(Number(range.oldest));
        date <= last;
        date = dateStr(dayStart(date) + 86400)
      ) {
        dates.add(date);
      }
    }
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

// Each rollup's legacy source rows for one day (?1 = date, ?2/?3 = the day's
// created_at bounds), keyed the way the old all-time summaries matched them:
// a legacy row counted only when the rollup had no row for the same key.
function rollups(tables) {
  const raw = tables.has("downloads");
  const archived = tables.has("downloads_daily");
  const sources = (rawSql, archivedSql) =>
    [raw && rawSql, archived && archivedSql]
      .filter(Boolean)
      .join(" UNION ALL ");

  return [
    {
      table: "daily_tool_stats",
      columns: "date, tool_id, downloads, unique_users",
      source: sources(
        `SELECT tool_id, COUNT(*) AS downloads, COUNT(DISTINCT ip_hash) AS unique_users
         FROM downloads WHERE created_at >= ?2 AND created_at < ?3
         GROUP BY tool_id`,
        // Archived rows lost their ip hashes; summing per-group unique ips is
        // the best available unique_users estimate.
        `SELECT tool_id, SUM(count) AS downloads, SUM(unique_ips) AS unique_users
         FROM downloads_daily WHERE date = ?1
         GROUP BY tool_id`,
      ),
      select: "tool_id, SUM(downloads), SUM(unique_users)",
      key: "tool_id",
      covered: "s.tool_id = src.tool_id",
    },
    {
      table: "daily_tool_version_stats",
      columns: "date, tool_id, version, downloads",
      source: sources(
        `SELECT tool_id, version, COUNT(*) AS downloads
         FROM downloads WHERE created_at >= ?2 AND created_at < ?3
         GROUP BY tool_id, version`,
        `SELECT tool_id, version, SUM(count) AS downloads
         FROM downloads_daily WHERE date = ?1
         GROUP BY tool_id, version`,
      ),
      select: "tool_id, version, SUM(downloads)",
      key: "tool_id, version",
      covered: "s.tool_id = src.tool_id AND s.version = src.version",
    },
    {
      table: "daily_tool_platform_stats",
      columns: "date, tool_id, platform_id, downloads",
      source: sources(
        `SELECT tool_id, COALESCE(platform_id, 0) AS platform_id, COUNT(*) AS downloads
         FROM downloads WHERE created_at >= ?2 AND created_at < ?3
         GROUP BY tool_id, COALESCE(platform_id, 0)`,
        `SELECT tool_id, COALESCE(platform_id, 0) AS platform_id, SUM(count) AS downloads
         FROM downloads_daily WHERE date = ?1
         GROUP BY tool_id, COALESCE(platform_id, 0)`,
      ),
      select: "tool_id, platform_id, SUM(downloads)",
      key: "tool_id, platform_id",
      covered: "s.tool_id = src.tool_id AND s.platform_id = src.platform_id",
    },
  ];
}

function uncovered(rollup) {
  return `
    FROM (${rollup.source}) src
    WHERE NOT EXISTS (
      SELECT 1 FROM ${rollup.table} s WHERE s.date = ?1 AND ${rollup.covered}
    )
  `;
}

// ?2/?3 only appear in the raw `downloads` source, and SQLite rejects binding
// a parameter the statement does not use.
function dayParams(date, tables) {
  if (!tables.has("downloads")) return [date];
  const start = dayStart(date);
  return [date, start, start + 86400];
}

export async function fold(config) {
  const tables = await existingTables(config);
  const dates = await legacyDates(config, tables);
  console.log(`Folding ${dates.length} legacy day(s)`);
  for (const date of dates) {
    for (const rollup of rollups(tables)) {
      await queryD1(
        config,
        `INSERT INTO ${rollup.table} (${rollup.columns})
         SELECT ?1, ${rollup.select} ${uncovered(rollup)}
         GROUP BY ${rollup.key}`,
        dayParams(date, tables),
        `fold ${rollup.table} ${date}`,
      );
    }
    console.log(`Folded ${date}`);
  }
  return { days: dates.length };
}

// Returns legacy keys still missing from the rollups, per table and day.
export async function verify(config) {
  const tables = await existingTables(config);
  const dates = await legacyDates(config, tables);
  const missing = [];
  for (const date of dates) {
    for (const rollup of rollups(tables)) {
      const [row] = await queryD1(
        config,
        `SELECT COUNT(*) AS count FROM (SELECT ${rollup.key} ${uncovered(rollup)} GROUP BY ${rollup.key})`,
        dayParams(date, tables),
        `verify ${rollup.table} ${date}`,
      );
      const count = Number(row?.count ?? 0);
      if (count > 0) missing.push({ table: rollup.table, date, keys: count });
    }
  }
  console.log(
    missing.length === 0
      ? `All ${dates.length} legacy day(s) are covered by the daily rollups`
      : `Missing from rollups: ${JSON.stringify(missing)}`,
  );
  return { days: dates.length, missing };
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

export async function drop(config) {
  const { missing } = await verify(config);
  if (missing.length > 0) {
    throw new Error(
      "Refusing to drop legacy tables while rollups are missing legacy rows; run --mode=fold first",
    );
  }
  const tables = await existingTables(config);
  for (const table of LEGACY_TABLES) {
    if (tables.has(table)) await deleteTable(config, table);
  }
  return { dropped: LEGACY_TABLES.filter((table) => tables.has(table)) };
}

async function main() {
  const { mode } = parseArgs(process.argv.slice(2));
  const config = {
    cloudflareAccountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
    cloudflareApiToken: requiredEnv("CLOUDFLARE_API_TOKEN"),
    analyticsDbId: process.env.ANALYTICS_DB_ID || DEFAULT_ANALYTICS_DB_ID,
  };
  const result = await { fold, verify, drop }[mode](config);
  console.log(JSON.stringify({ success: true, mode, result }, null, 2));
  if (mode === "verify" && result.missing.length > 0) process.exitCode = 1;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
