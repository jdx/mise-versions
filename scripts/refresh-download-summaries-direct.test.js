#!/usr/bin/env node
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import {
  refreshSummaries,
  toolIdRanges,
  trendingRows,
} from "./refresh-download-summaries-direct.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const config = {
  cloudflareAccountId: "account",
  cloudflareApiToken: "d1-token",
  analyticsDbId: "database",
};

// 2026-09-27T12:00:00Z
const NOW = Date.UTC(2026, 8, 27, 12) / 1000;

function daysAgo(days) {
  return new Date((NOW - days * 86400) * 1000).toISOString().split("T")[0];
}

function createDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tools (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      latest_version TEXT,
      backends TEXT
    );
    CREATE TABLE downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id INTEGER NOT NULL,
      version TEXT NOT NULL,
      platform_id INTEGER,
      ip_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE downloads_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id INTEGER NOT NULL,
      version TEXT NOT NULL,
      platform_id INTEGER,
      date TEXT NOT NULL,
      count INTEGER NOT NULL,
      unique_ips INTEGER NOT NULL
    );
    CREATE TABLE daily_tool_stats (
      date TEXT NOT NULL, tool_id INTEGER NOT NULL,
      downloads INTEGER NOT NULL, unique_users INTEGER NOT NULL,
      PRIMARY KEY (date, tool_id)
    );
    CREATE TABLE daily_tool_version_stats (
      date TEXT NOT NULL, tool_id INTEGER NOT NULL, version TEXT NOT NULL,
      downloads INTEGER NOT NULL,
      PRIMARY KEY (date, tool_id, version)
    );
    CREATE TABLE daily_tool_platform_stats (
      date TEXT NOT NULL, tool_id INTEGER NOT NULL, platform_id INTEGER NOT NULL,
      downloads INTEGER NOT NULL,
      PRIMARY KEY (date, tool_id, platform_id)
    );
    CREATE TABLE tool_download_summaries (
      tool_id INTEGER PRIMARY KEY,
      downloads_30d INTEGER NOT NULL DEFAULT 0,
      downloads_all_time INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
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
      backend_type TEXT PRIMARY KEY,
      tool_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE trending_tool_summaries (
      tool_id INTEGER PRIMARY KEY,
      downloads_30d INTEGER NOT NULL DEFAULT 0,
      daily_boost REAL NOT NULL DEFAULT 0,
      trending_score REAL NOT NULL DEFAULT 0,
      sparkline TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

// Serves the D1 REST query endpoint from a local SQLite database.
function serveD1(db, statements = []) {
  globalThis.fetch = async (_url, options) => {
    const { sql, params } = JSON.parse(options.body);
    statements.push(sql);
    const results = db.prepare(sql).all(...params);
    return new Response(
      JSON.stringify({ success: true, result: [{ success: true, results }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}

describe("refresh-download-summaries-direct", () => {
  it("splits tool ids into bounded ranges", () => {
    const ids = Array.from({ length: 250 }, (_, index) => 250 - index);
    assert.deepEqual(toolIdRanges(ids), [
      [1, 100],
      [101, 200],
      [201, 250],
    ]);
    assert.deepEqual(toolIdRanges([]), []);
  });

  it("rebuilds stale summaries from the daily rollups", async () => {
    const db = createDb();
    db.exec(`
      INSERT INTO tools VALUES
        (1, 'worktrunk', '0.79.0', '["aqua:max-sixty/worktrunk","cargo:worktrunk"]'),
        (2, 'jq', '1.8.1', '["aqua:jqlang/jq"]'),
        (3, 'archived', NULL, '["asdf:archived"]');
      INSERT INTO tool_download_summaries VALUES (1, 0, 5, '2026-07-06T00:00:00.000Z');
      INSERT INTO tool_version_download_summaries VALUES (1, '0.57.0', 5);
      -- No longer present in any source, e.g. after a rollup correction.
      INSERT INTO tool_version_download_summaries VALUES (1, '0.0.9', 3);
      INSERT INTO tool_platform_download_summaries VALUES (1, 9, 3);
      INSERT INTO backend_tool_summaries VALUES ('ubi', 9, '2026-07-06T00:00:00.000Z');
    `);
    const insertVersion = db.prepare(
      "INSERT INTO daily_tool_version_stats VALUES (?, ?, ?, ?)",
    );
    insertVersion.run(daysAgo(100), 1, "0.57.0", 5);
    insertVersion.run(daysAgo(2), 1, "0.79.0", 40);
    insertVersion.run(daysAgo(1), 1, "0.79.0", 60);
    db.exec(`
      INSERT INTO daily_tool_stats VALUES
        ('${daysAgo(100)}', 1, 5, 5),
        ('${daysAgo(2)}', 1, 40, 30),
        ('${daysAgo(1)}', 1, 60, 50);
      INSERT INTO daily_tool_platform_stats VALUES
        ('${daysAgo(100)}', 1, 1, 5),
        ('${daysAgo(1)}', 1, 1, 60),
        ('${daysAgo(2)}', 1, 2, 40);
      -- A pre-rollup day only present in downloads_daily still counts.
      INSERT INTO downloads_daily (tool_id, version, platform_id, date, count, unique_ips)
        VALUES (1, '0.1.0', 1, '2025-12-01', 7, 7);
    `);

    const statements = [];
    serveD1(db, statements);
    const results = await refreshSummaries(config, NOW);

    assert.deepEqual(results, {
      tools: 3,
      chunks: 1,
      backends: 2,
      trending: 0,
    });
    const perToolWrites = statements.filter((sql) =>
      /(INTO|DELETE FROM) tool_(download|platform_download|version_download)_summaries/.test(
        sql,
      ),
    );
    assert.equal(perToolWrites.length, 5);
    assert.ok(perToolWrites.every((sql) => sql.includes("BETWEEN ?1 AND ?2")));

    assert.deepEqual(
      db
        .prepare(
          "SELECT tool_id, downloads_30d, downloads_all_time FROM tool_download_summaries ORDER BY tool_id",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { tool_id: 1, downloads_30d: 100, downloads_all_time: 112 },
        { tool_id: 2, downloads_30d: 0, downloads_all_time: 0 },
        { tool_id: 3, downloads_30d: 0, downloads_all_time: 0 },
      ],
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT version, downloads_all_time FROM tool_version_download_summaries WHERE tool_id = 1 ORDER BY version",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { version: "0.1.0", downloads_all_time: 7 },
        { version: "0.57.0", downloads_all_time: 5 },
        { version: "0.79.0", downloads_all_time: 100 },
      ],
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT platform_id, downloads_all_time FROM tool_platform_download_summaries WHERE tool_id = 1 ORDER BY platform_id",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { platform_id: 1, downloads_all_time: 72 },
        { platform_id: 2, downloads_all_time: 40 },
      ],
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT backend_type, tool_count FROM backend_tool_summaries ORDER BY backend_type",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { backend_type: "aqua", tool_count: 2 },
        { backend_type: "cargo", tool_count: 1 },
      ],
    );
  });

  it("scores trending tools by recent daily momentum", async () => {
    const db = createDb();
    db.exec(
      `INSERT INTO tools VALUES (1, 'worktrunk', '0.79.0', '["aqua:max-sixty/worktrunk"]')`,
    );
    const insert = db.prepare(
      "INSERT INTO daily_tool_stats VALUES (?, 1, ?, 1)",
    );
    for (let day = 1; day <= 30; day++) {
      insert.run(daysAgo(day), day <= 3 ? 100 : 20);
    }
    // Today is still open and must not affect the score or the sparkline.
    insert.run(daysAgo(0), 10_000);

    serveD1(db);
    await refreshSummaries(config, NOW);

    const [row] = db
      .prepare(
        "SELECT tool_id, downloads_30d, daily_boost, trending_score, sparkline FROM trending_tool_summaries",
      )
      .all();
    assert.equal(row.tool_id, 1);
    assert.equal(row.downloads_30d, 840);
    assert.ok(row.daily_boost > 2);
    assert.equal(row.trending_score, row.daily_boost);
    assert.deepEqual(JSON.parse(row.sparkline), [
      ...Array(10).fill(20),
      100,
      100,
      100,
    ]);
  });

  it("clears previous backend and trending rows when nothing qualifies", async () => {
    const db = createDb();
    db.exec(`
      INSERT INTO tools VALUES (1, 'archived', NULL, '["asdf:archived"]');
      INSERT INTO backend_tool_summaries VALUES ('asdf', 1, '2026-07-06T00:00:00.000Z');
      INSERT INTO trending_tool_summaries VALUES (1, 900, 3, 3, '[]', '2026-07-06T00:00:00.000Z');
    `);

    serveD1(db);
    const results = await refreshSummaries(config, NOW);

    assert.equal(results.backends, 0);
    assert.equal(results.trending, 0);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM backend_tool_summaries").get()
        .count,
      0,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM trending_tool_summaries").get()
        .count,
      0,
    );
  });

  it("skips tools with flat daily downloads", () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      tool_id: 1,
      downloads_30d: 600,
      date: daysAgo(index + 1),
      downloads: 20,
    }));
    assert.deepEqual(trendingRows(rows, NOW), []);
  });
});
