#!/usr/bin/env node
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { refreshSummaries } from "./refresh-download-summaries-direct.js";
import {
  drop,
  fold,
  parseArgs,
  verify,
} from "./retire-legacy-downloads-direct.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const config = {
  cloudflareAccountId: "account",
  cloudflareApiToken: "d1-token",
  analyticsDbId: "database",
  cutoverDate: "2026-06-12",
};

const NOW = Date.UTC(2026, 8, 27, 12) / 1000;

function ts(date, hour = 12) {
  return Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`) / 1000;
}

function createDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tools (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      latest_version TEXT, backends TEXT
    );
    CREATE TABLE downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id INTEGER NOT NULL, version TEXT NOT NULL, platform_id INTEGER,
      ip_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_downloads_created_at ON downloads(created_at);
    CREATE TABLE downloads_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id INTEGER NOT NULL, version TEXT NOT NULL, platform_id INTEGER,
      date TEXT NOT NULL, count INTEGER NOT NULL, unique_ips INTEGER NOT NULL
    );
    CREATE INDEX idx_downloads_daily_date ON downloads_daily(date);
    CREATE TABLE version_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE daily_tool_stats (
      date TEXT NOT NULL, tool_id INTEGER NOT NULL,
      downloads INTEGER NOT NULL, unique_users INTEGER NOT NULL,
      PRIMARY KEY (date, tool_id)
    );
    CREATE TABLE daily_tool_version_stats (
      date TEXT NOT NULL, tool_id INTEGER NOT NULL, version TEXT NOT NULL,
      downloads INTEGER NOT NULL, PRIMARY KEY (date, tool_id, version)
    );
    CREATE TABLE daily_tool_platform_stats (
      date TEXT NOT NULL, tool_id INTEGER NOT NULL, platform_id INTEGER NOT NULL,
      downloads INTEGER NOT NULL, PRIMARY KEY (date, tool_id, platform_id)
    );
    CREATE TABLE daily_stats (
      date TEXT PRIMARY KEY, total_downloads INTEGER NOT NULL,
      unique_users INTEGER NOT NULL
    );
    CREATE TABLE daily_combined_stats (
      date TEXT PRIMARY KEY, unique_users INTEGER NOT NULL
    );
    CREATE TABLE daily_version_stats (
      date TEXT PRIMARY KEY, total_requests INTEGER NOT NULL,
      unique_users INTEGER NOT NULL
    );
    CREATE TABLE tool_download_summaries (
      tool_id INTEGER PRIMARY KEY, downloads_30d INTEGER NOT NULL DEFAULT 0,
      downloads_all_time INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE tool_platform_download_summaries (
      tool_id INTEGER NOT NULL, platform_id INTEGER NOT NULL,
      downloads_all_time INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tool_id, platform_id)
    );
    CREATE TABLE tool_version_download_summaries (
      tool_id INTEGER NOT NULL, version TEXT NOT NULL,
      downloads_all_time INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tool_id, version)
    );
    CREATE TABLE backend_tool_summaries (
      backend_type TEXT PRIMARY KEY, tool_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE trending_tool_summaries (
      tool_id INTEGER PRIMARY KEY, downloads_30d INTEGER NOT NULL DEFAULT 0,
      daily_boost REAL NOT NULL DEFAULT 0, trending_score REAL NOT NULL DEFAULT 0,
      sparkline TEXT NOT NULL, updated_at TEXT NOT NULL
    );

    INSERT INTO tools VALUES (1, 'jq', '1.8.1', '[]'), (2, 'node', '24.0.0', '[]');

    -- 2026-05-01 already has rollups for jq, so its raw rows must not be
    -- counted again, but node has no rollup that day.
    INSERT INTO daily_tool_stats VALUES ('2026-05-01', 1, 2, 2);
    INSERT INTO daily_tool_version_stats VALUES ('2026-05-01', 1, '1.8.1', 2);
    INSERT INTO daily_tool_platform_stats VALUES ('2026-05-01', 1, 1, 2);
    INSERT INTO version_requests (ip_hash, created_at) VALUES
      ('a', ${ts("2026-05-01")}), ('c', ${ts("2026-05-01")});
    -- 2026-05-03 already has global rollups, so they must be left alone.
    INSERT INTO daily_stats VALUES ('2026-05-03', 9, 9);
    INSERT INTO daily_combined_stats VALUES ('2026-05-03', 9);
  `);
  const raw = db.prepare(
    "INSERT INTO downloads (tool_id, version, platform_id, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  raw.run(1, "1.8.1", 1, "a", ts("2026-05-01"));
  raw.run(1, "1.8.1", 1, "b", ts("2026-05-01"));
  raw.run(2, "24.0.0", 1, "a", ts("2026-05-01", 0));
  raw.run(2, "24.0.0", null, "b", ts("2026-05-01", 23));
  raw.run(2, "23.0.0", 1, "a", ts("2026-05-03"));
  // Archived day with no rollups at all.
  db.exec(`
    INSERT INTO downloads_daily (tool_id, version, platform_id, date, count, unique_ips)
    VALUES (1, '1.7.0', 1, '2026-02-01', 10, 4), (1, '1.7.0', 2, '2026-02-01', 5, 3);
  `);
  return db;
}

function serveD1(db) {
  globalThis.fetch = async (_url, options) => {
    const { sql, params } = JSON.parse(options.body);
    const results = db.prepare(sql).all(...params);
    return new Response(
      JSON.stringify({ success: true, result: [{ success: true, results }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

function rows(db, sql) {
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

describe("retire-legacy-downloads-direct", () => {
  it("requires a mode", () => {
    assert.deepEqual(parseArgs(["--mode=fold"]), { mode: "fold" });
    assert.throws(() => parseArgs([]), /--mode must be one of/);
    assert.throws(() => parseArgs(["--mode=nuke"]), /--mode must be one of/);
  });

  it("refuses to drop before legacy days are folded", async () => {
    const db = createDb();
    serveD1(db);

    const { missing } = await verify(config);
    assert.deepEqual(
      missing.map(({ table, date }) => `${table} ${date}`),
      [
        "daily_tool_stats 2026-02-01",
        "daily_tool_version_stats 2026-02-01",
        "daily_tool_platform_stats 2026-02-01",
        "daily_tool_stats 2026-05-01",
        "daily_tool_version_stats 2026-05-01",
        "daily_tool_platform_stats 2026-05-01",
        "daily_stats 2026-05-01",
        "daily_combined_stats 2026-05-01",
        "daily_version_stats 2026-05-01",
        "daily_tool_stats 2026-05-03",
        "daily_tool_version_stats 2026-05-03",
        "daily_tool_platform_stats 2026-05-03",
      ],
    );
    await assert.rejects(drop(config), /run --mode=fold first/);
    assert.equal(rows(db, "SELECT COUNT(*) AS n FROM downloads")[0].n, 5);
  });

  it("never folds the cutover day from D1 alone", async () => {
    const db = createDb();
    db.prepare(
      "INSERT INTO downloads (tool_id, version, platform_id, ip_hash, created_at) VALUES (1, '1.8.1', 1, 'a', ?)",
    ).run(ts("2026-06-12"));
    serveD1(db);

    await fold(config);
    assert.deepEqual(
      rows(db, "SELECT date FROM daily_tool_stats WHERE date = '2026-06-12'"),
      [],
    );
    const { missing } = await verify(config);
    assert.ok(missing.some(({ date }) => date === "2026-06-12"));
    await assert.rejects(drop(config), /run --mode=fold first/);
  });

  it("keeps all-time totals after folding and dropping", async () => {
    const db = createDb();
    serveD1(db);

    await fold(config);
    // Re-running only fills rows that are still missing.
    await fold(config);
    assert.deepEqual((await verify(config)).missing, []);

    assert.deepEqual(
      rows(
        db,
        "SELECT date, tool_id, downloads, unique_users FROM daily_tool_stats ORDER BY date, tool_id",
      ),
      [
        { date: "2026-02-01", tool_id: 1, downloads: 15, unique_users: 7 },
        { date: "2026-05-01", tool_id: 1, downloads: 2, unique_users: 2 },
        { date: "2026-05-01", tool_id: 2, downloads: 2, unique_users: 2 },
        { date: "2026-05-03", tool_id: 2, downloads: 1, unique_users: 1 },
      ],
    );

    assert.deepEqual(rows(db, "SELECT * FROM daily_stats ORDER BY date"), [
      { date: "2026-05-01", total_downloads: 4, unique_users: 2 },
      { date: "2026-05-03", total_downloads: 9, unique_users: 9 },
    ]);
    assert.deepEqual(
      rows(db, "SELECT * FROM daily_combined_stats ORDER BY date"),
      [
        { date: "2026-05-01", unique_users: 3 },
        { date: "2026-05-03", unique_users: 9 },
      ],
    );
    assert.deepEqual(rows(db, "SELECT * FROM daily_version_stats"), [
      { date: "2026-05-01", total_requests: 2, unique_users: 2 },
    ]);

    assert.deepEqual(await drop(config), {
      dropped: ["downloads", "downloads_daily", "version_requests"],
    });
    assert.deepEqual(
      rows(
        db,
        "SELECT name FROM sqlite_master WHERE name LIKE 'downloads%' OR name = 'version_requests'",
      ),
      [],
    );
    // Dropping again is a no-op.
    assert.deepEqual(await drop(config), { dropped: [] });

    await refreshSummaries(config, NOW);
    assert.deepEqual(
      rows(
        db,
        "SELECT tool_id, downloads_all_time FROM tool_download_summaries ORDER BY tool_id",
      ),
      [
        { tool_id: 1, downloads_all_time: 17 },
        { tool_id: 2, downloads_all_time: 3 },
      ],
    );
    assert.deepEqual(
      rows(
        db,
        "SELECT tool_id, version, downloads_all_time FROM tool_version_download_summaries ORDER BY tool_id, version",
      ),
      [
        { tool_id: 1, version: "1.7.0", downloads_all_time: 15 },
        { tool_id: 1, version: "1.8.1", downloads_all_time: 2 },
        { tool_id: 2, version: "23.0.0", downloads_all_time: 1 },
        { tool_id: 2, version: "24.0.0", downloads_all_time: 2 },
      ],
    );
    assert.deepEqual(
      rows(
        db,
        "SELECT tool_id, platform_id, downloads_all_time FROM tool_platform_download_summaries ORDER BY tool_id, platform_id",
      ),
      [
        { tool_id: 1, platform_id: 1, downloads_all_time: 12 },
        { tool_id: 1, platform_id: 2, downloads_all_time: 5 },
        { tool_id: 2, platform_id: 0, downloads_all_time: 1 },
        { tool_id: 2, platform_id: 1, downloads_all_time: 2 },
      ],
    );
  });
});
