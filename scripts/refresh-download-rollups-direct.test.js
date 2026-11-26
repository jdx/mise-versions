#!/usr/bin/env node
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  batchUpsert,
  upsertBatches,
  parseArgs,
  refreshDate,
} from "./refresh-download-rollups-direct.js";
import { decodeD1Body } from "./lib/d1-test-helpers.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function config() {
  return {
    cloudflareAccountId: "account",
    cloudflareApiToken: "d1-token",
    analyticsEngineAccountId: "account",
    analyticsEngineApiToken: "ae-token",
    analyticsDbId: "database",
    dataset: "events",
    cutoverDate: "2026-06-12",
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("refresh-download-rollups-direct", () => {
  it("validates the requested backfill window", () => {
    assert.deepEqual(parseArgs(["--date=2026-07-14", "--days=7"]), {
      date: "2026-07-14",
      days: 7,
    });
    assert.throws(() => parseArgs(["--days=32"]), /integer from 1 to 31/);
  });

  it("binds each upsert batch as one JSON array of rows", async () => {
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return jsonResponse({
        success: true,
        result: [{ success: true, results: [] }],
      });
    };

    const rows = Array.from({ length: 2500 }, (_, index) => [
      "2026-07-14",
      index,
      index * 2,
      index * 3,
    ]);
    await batchUpsert(
      config(),
      "daily_tool_stats",
      ["date", "tool_id", "downloads", "unique_users"],
      rows,
    );

    // 2,500 rows used to take 100 requests of 25 rows each.
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.params.length, 1);
      assert.equal(
        request.sql,
        "INSERT OR REPLACE INTO daily_tool_stats (date, tool_id, downloads, unique_users) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?)",
      );
    }
    assert.deepEqual(
      requests.flatMap((request) => JSON.parse(request.params[0])),
      rows,
    );
  });

  it("splits upsert batches by row count and JSON size", () => {
    assert.deepEqual(
      upsertBatches(Array.from({ length: 2001 }, (_, i) => [i])).map(
        (batch) => batch.length,
      ),
      [1000, 1000, 1],
    );
    const wide = Array.from({ length: 10 }, (_, i) => [i, "x".repeat(10_000)]);
    const batches = upsertBatches(wide);
    assert.deepEqual(batches.flat(), wide);
    for (const batch of batches) {
      assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 64 * 1024);
    }
    // A row over the byte limit still goes, in a batch of its own.
    const huge = [[1], ["y".repeat(70_000)], [2]];
    assert.deepEqual(upsertBatches(huge), [
      [[1]],
      [["y".repeat(70_000)]],
      [[2]],
    ]);
  });

  it("upserts with SQLite semantics: JSON types, NULL, last duplicate wins", async () => {
    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      return; // node:sqlite is not available on this Node version
    }
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE t (date TEXT, tool_id INTEGER, version TEXT, downloads INTEGER, note TEXT, PRIMARY KEY (date, tool_id, version))",
    );
    globalThis.fetch = async (_url, options) => {
      const { sql, params } = JSON.parse(options.body);
      db.prepare(sql).run(...params);
      return jsonResponse({
        success: true,
        result: [{ success: true, results: [] }],
      });
    };
    await batchUpsert(
      config(),
      "t",
      ["date", "tool_id", "version", "downloads", "note"],
      [
        ["2026-07-14", 1, "1.20", 5, null],
        ["2026-07-14", 2, `it's "quoted" ünï`, 7, "x"],
        ["2026-07-14", 1, "1.20", 9, "later"],
      ],
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT tool_id, version, downloads, note, typeof(tool_id) AS id_type, typeof(version) AS version_type FROM t ORDER BY tool_id",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          tool_id: 1,
          version: "1.20",
          downloads: 9,
          note: "later",
          id_type: "integer",
          version_type: "text",
        },
        {
          tool_id: 2,
          version: `it's "quoted" ünï`,
          downloads: 7,
          note: "x",
          id_type: "integer",
          version_type: "text",
        },
      ],
    );
  });

  it("persists core activity rows before propagating a dimension failure", async () => {
    const d1Writes = [];
    globalThis.fetch = async (url, options) => {
      const body = options.body;
      if (String(url).includes("analytics_engine")) {
        if (body.includes("GROUP BY tool")) {
          return jsonResponse(
            { success: false, errors: [{ code: 1000 }] },
            422,
          );
        }
        if (body.includes("blob1 IN")) {
          return jsonResponse({ data: [{ unique_users: "5" }] });
        }
        if (body.includes(" AS total")) {
          return jsonResponse({
            data: [{ total: "10", unique_users: "3" }],
          });
        }
        return jsonResponse({ data: [] });
      }

      d1Writes.push(decodeD1Body(body));
      return jsonResponse({
        success: true,
        result: [{ success: true, results: [] }],
      });
    };

    await assert.rejects(
      refreshDate(config(), "2026-07-14"),
      /Cloudflare API failed 422/,
    );
    assert.equal(d1Writes.length, 2);
    assert.ok(d1Writes.some(({ sql }) => sql.includes("daily_stats")));
    assert.ok(d1Writes.some(({ sql }) => sql.includes("daily_combined_stats")));
  });

  it("adds Logpush beacon installs from LOGPUSH_CUTOVER_DATE on", async () => {
    const d1Writes = [];
    globalThis.fetch = async (url, options) => {
      const body = options.body;
      if (String(url).includes("analytics_engine")) {
        if (body.includes(" AS total")) {
          return jsonResponse({ data: [{ total: "10", unique_users: "3" }] });
        }
        if (body.includes("blob1 IN")) {
          return jsonResponse({ data: [{ unique_users: "5" }] });
        }
        if (body.includes("GROUP BY tool, version")) {
          return jsonResponse({
            data: [{ tool: "node", version: "22", downloads: "4" }],
          });
        }
        if (body.includes("GROUP BY tool, backend_type")) {
          return jsonResponse({ data: [] });
        }
        if (body.includes("GROUP BY tool, os, arch")) {
          return jsonResponse({ data: [] });
        }
        if (body.includes("GROUP BY backend_type")) {
          return jsonResponse({ data: [] });
        }
        if (body.includes("GROUP BY tool")) {
          return jsonResponse({
            data: [{ tool: "node", downloads: "4", unique_users: "2" }],
          });
        }
        return jsonResponse({ data: [] });
      }

      const { sql, params } = decodeD1Body(body);
      let results = [];
      if (sql.startsWith("SELECT id, name FROM tools")) {
        results = [{ id: 1, name: "node" }];
      } else if (sql.includes("FROM logpush_daily_stats")) {
        results = [{ total_downloads: 6, unique_users: 4 }];
      } else if (sql.includes("FROM logpush_daily_dau")) {
        results = [{ unique_users: 40 }];
      } else if (sql.includes("FROM logpush_daily_tool_stats")) {
        results = [
          { date: "2026-07-14", tool_id: 1, downloads: 5, unique_users: 3 },
          { date: "2026-07-14", tool_id: 2, downloads: 1, unique_users: 1 },
        ];
      } else if (sql.includes("FROM logpush_daily_tool_version_stats")) {
        results = [
          { date: "2026-07-14", tool_id: 1, version: "22", downloads: 5 },
        ];
      } else if (sql.startsWith("INSERT")) {
        d1Writes.push({ sql, params });
      }
      return jsonResponse({
        success: true,
        result: [{ success: true, results }],
      });
    };

    const result = await refreshDate(
      { ...config(), logpushCutoverDate: "2026-07-14" },
      "2026-07-14",
    );
    assert.equal(result.totalDownloads, 16);
    const write = (table) =>
      d1Writes.find(({ sql }) => sql.includes(`INTO ${table} `)).params;
    assert.deepEqual(write("daily_stats"), ["2026-07-14", 16, 7]);
    // Logpush DAU already includes the Analytics Engine clients (5), so it
    // replaces that count instead of being added to it.
    assert.deepEqual(write("daily_combined_stats"), ["2026-07-14", 40]);
    assert.deepEqual(write("daily_tool_stats"), [
      "2026-07-14",
      1,
      9,
      5,
      "2026-07-14",
      2,
      1,
      1,
    ]);
    assert.deepEqual(write("daily_tool_version_stats"), [
      "2026-07-14",
      1,
      "22",
      9,
    ]);
  });

  it("refuses to publish a cutover day without Logpush rows", async () => {
    globalThis.fetch = async () =>
      jsonResponse({ success: true, result: [{ success: true, results: [] }] });
    await assert.rejects(
      refreshDate(
        { ...config(), logpushCutoverDate: "2026-07-01" },
        "2026-07-14",
      ),
      /no logpush_daily_stats row/,
    );
  });

  it("refuses to publish a cutover day without its Logpush DAU", async () => {
    globalThis.fetch = async (_url, options) => {
      const { sql } = decodeD1Body(options.body);
      const results = sql.includes("FROM logpush_daily_stats")
        ? [{ total_downloads: 1, unique_users: 1 }]
        : [];
      return jsonResponse({
        success: true,
        result: [{ success: true, results }],
      });
    };
    await assert.rejects(
      refreshDate(
        { ...config(), logpushCutoverDate: "2026-07-01" },
        "2026-07-14",
      ),
      /no logpush_daily_dau row/,
    );
  });

  it("removes a date's dimension rows that are no longer reported", async () => {
    const d1 = [];
    globalThis.fetch = async (url, options) => {
      const body = options.body;
      if (String(url).includes("analytics_engine")) {
        if (body.includes(" AS total")) {
          return jsonResponse({ data: [{ total: "4", unique_users: "2" }] });
        }
        if (body.includes("blob1 IN")) {
          return jsonResponse({ data: [{ unique_users: "2" }] });
        }
        if (body.includes("GROUP BY tool, version")) {
          return jsonResponse({
            data: [{ tool: "node", version: "22", downloads: "4" }],
          });
        }
        return jsonResponse({ data: [] });
      }
      const { sql, params } = decodeD1Body(body);
      d1.push({ sql, params });
      let results = [];
      if (sql.startsWith("SELECT id, name FROM tools")) {
        results = [{ id: 1, name: "node" }];
      } else if (
        sql.startsWith("SELECT tool_id, version FROM daily_tool_version_stats")
      ) {
        // 22 is current; 21 and the other tool's version dropped out
        results = [
          { tool_id: 1, version: "22" },
          { tool_id: 1, version: "21" },
          { tool_id: 9, version: "beacon-only" },
        ];
      }
      return jsonResponse({
        success: true,
        result: [{ success: true, results }],
      });
    };

    await refreshDate(config(), "2026-07-14");
    const deletes = d1.filter(({ sql }) => sql.startsWith("DELETE"));
    assert.equal(deletes.length, 1);
    assert.match(
      deletes[0].sql,
      /^DELETE FROM daily_tool_version_stats WHERE date = \? AND \(\(tool_id = \? AND version = \?\) OR \(tool_id = \? AND version = \?\)\)$/,
    );
    assert.deepEqual(deletes[0].params, [
      "2026-07-14",
      1,
      "21",
      9,
      "beacon-only",
    ]);
    // The current rows are upserted before anything is removed.
    const upsert = d1.findIndex(({ sql }) =>
      sql.startsWith("INSERT OR REPLACE INTO daily_tool_version_stats"),
    );
    assert.ok(upsert >= 0 && upsert < d1.indexOf(deletes[0]));
  });
});
