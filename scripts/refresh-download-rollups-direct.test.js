#!/usr/bin/env node
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  batchUpsert,
  orderedDates,
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
  it("prioritizes the completed day before today and older backfill dates", () => {
    assert.deepEqual(orderedDates("2026-07-15", 4), [
      "2026-07-14",
      "2026-07-15",
      "2026-07-13",
      "2026-07-12",
    ]);
  });

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
});
