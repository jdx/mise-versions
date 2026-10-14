#!/usr/bin/env node
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  batchUpsert,
  parseArgs,
  refreshDate,
} from "./refresh-download-rollups-direct.js";

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

  it("chunks D1 upserts below the parameter limit", async () => {
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return jsonResponse({
        success: true,
        result: [{ success: true, results: [] }],
      });
    };

    const rows = Array.from({ length: 30 }, (_, index) => [
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

    assert.equal(requests.length, 2);
    assert.equal(requests[0].params.length, 100);
    assert.equal(requests[1].params.length, 20);
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

      d1Writes.push(JSON.parse(body));
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

      const { sql, params } = JSON.parse(body);
      let results = [];
      if (sql.startsWith("SELECT id, name FROM tools")) {
        results = [{ id: 1, name: "node" }];
      } else if (sql.includes("FROM logpush_daily_stats")) {
        results = [{ total_downloads: 6, unique_users: 4 }];
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
      const { sql, params } = JSON.parse(body);
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
