#!/usr/bin/env node
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { afterEach, describe, it } from "node:test";
import {
  forEachLine,
  parseArgs,
  refreshDate,
  trailingMau,
} from "./refresh-logpush-analytics-direct.js";
import { decodeUserHashes, encodeUserHashes } from "./lib/user-hash-set.js";
import { hashIp } from "./lib/logpush.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const UA = "mise/2026.10.10 linux-x64 (2026-10-11) bash";
const SECRET = "secret";

function line(overrides) {
  return JSON.stringify({
    EdgeStartTimestamp: "2026-10-13T12:00:00Z",
    ClientIP: "198.51.100.1",
    ClientRequestHost: "mise-versions.jdx.dev",
    ClientRequestMethod: "GET",
    ClientRequestURI: "/data/node.toml",
    ClientRequestUserAgent: UA,
    ClientRequestSource: "eyeball",
    EdgeResponseStatus: 200,
    WorkerSubrequest: false,
    ...overrides,
  });
}

function fakeR2(objects) {
  const store = new Map(Object.entries(objects));
  return {
    store,
    async listObjects(prefix) {
      return [...store.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, size: store.get(key).length }));
    },
    async getObject(key) {
      return store.get(key) ?? null;
    },
    async putObject(key, body) {
      store.set(key, body);
    },
  };
}

function fakeD1() {
  const writes = [];
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/d1\/database\/db\/query$/);
    const { sql, params } = JSON.parse(options.body);
    writes.push({ sql, params });
    let results = [];
    if (sql.startsWith("SELECT id, name FROM tools")) {
      results = [
        { id: 1, name: "node" },
        { id: 2, name: "jq" },
      ];
    } else if (sql.startsWith("SELECT id, os, arch FROM platforms")) {
      results = [{ id: 7, os: "linux", arch: "x64" }];
    }
    return new Response(
      JSON.stringify({ success: true, result: [{ success: true, results }] }),
    );
  };
  return writes;
}

function config(r2) {
  return {
    cloudflareAccountId: "acct",
    cloudflareApiToken: "token",
    analyticsDbId: "db",
    ipHashSecret: SECRET,
    prefix: "http_requests",
    zones: ["jdx.dev"],
    hosts: null,
    beaconHosts: ["mise-versions.jdx.dev"],
    statePrefix: "rollups/mise-users/v1",
    dryRun: false,
    r2,
  };
}

describe("refresh-logpush-analytics-direct", () => {
  it("validates arguments", () => {
    assert.deepEqual(
      parseArgs(["--date=2026-10-13", "--days=3", "--dry-run"]),
      {
        date: "2026-10-13",
        days: 3,
        dryRun: true,
      },
    );
    assert.throws(() => parseArgs(["--days=0"]), /integer from 1 to 31/);
    assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
  });

  it("splits gzip'd and plain NDJSON into lines", async () => {
    const seen = [];
    await forEachLine(gzipSync("a\nb\n\nc"), (l) => seen.push(l));
    await forEachLine(Buffer.from("d\ne\n"), (l) => seen.push(l));
    assert.deepEqual(seen, ["a", "b", "", "c", "d", "e"]);
  });

  it("unions the trailing 30 days and reports coverage", async () => {
    const sets = {
      "2026-10-13": Float64Array.from([1, 2]),
      "2026-09-14": Float64Array.from([2, 3]),
      "2026-09-13": Float64Array.from([4]), // outside the window
    };
    assert.deepEqual(
      await trailingMau("2026-10-13", async (d) => sets[d] ?? null),
      { mau: 3, daysCovered: 2 },
    );
  });

  it("rolls a day of logs into the shadow tables and stores the user set", async () => {
    const day = "http_requests/jdx.dev/20261013";
    const r2 = fakeR2({
      [`${day}/20261013T000000Z_20261013T120000Z_a.log.gz`]: gzipSync(
        [
          line({}),
          line({
            ClientIP: "198.51.100.2",
            ClientRequestUserAgent: `${UA} ci`,
          }),
          line({ ClientRequestUserAgent: "Mozilla/5.0" }),
          line({
            ClientIP: "198.51.100.3",
            ClientRequestURI:
              "/t?tool=node&full=core%3Anode&version=22.1.0&os=linux&arch=x64",
          }),
          line({
            ClientIP: "198.51.100.3",
            EdgeStartTimestamp: "2026-10-13T13:00:00Z",
            ClientRequestURI:
              "/t?tool=node&full=core%3Anode&version=22.1.0&os=linux&arch=x64",
          }),
          line({
            ClientIP: "198.51.100.3",
            ClientRequestURI: "/t?tool=unknown-tool&version=1",
          }),
        ].join("\n"),
      ),
      // Previous day's folder: the batch crosses midnight into the 13th.
      "http_requests/jdx.dev/20261012/20261012T235500Z_20261013T000500Z_b.log.gz":
        gzipSync(
          [
            line({
              ClientIP: "198.51.100.9",
              EdgeStartTimestamp: "2026-10-12T23:59:00Z",
            }),
            line({
              ClientIP: "198.51.100.4",
              EdgeStartTimestamp: "2026-10-13T00:01:00Z",
            }),
          ].join("\n"),
        ),
      "rollups/mise-users/v1/2026-10-12.bin.gz": encodeUserHashes(
        Float64Array.from(
          [
            parseInt(hashIp("198.51.100.9", SECRET), 16),
            parseInt(hashIp("198.51.100.1", SECRET), 16),
          ].sort((a, b) => a - b),
        ),
      ),
    });
    const writes = fakeD1();

    const result = await refreshDate(config(r2), "2026-10-13", new Map());
    assert.equal(result.dau, 3);
    assert.equal(result.mau, 4);
    assert.equal(result.mauDaysCovered, 2);
    assert.equal(result.ciRequests, 1);
    assert.equal(result.downloads, 2);

    const stored = decodeUserHashes(
      r2.store.get("rollups/mise-users/v1/2026-10-13.bin.gz"),
    );
    assert.equal(stored.length, 3);

    const insert = (table) =>
      writes.find(({ sql }) =>
        sql.startsWith(`INSERT OR REPLACE INTO ${table} `),
      );
    assert.deepEqual(insert("logpush_daily_dau").params.slice(0, 4), [
      "2026-10-13",
      3,
      5,
      1,
    ]);
    assert.deepEqual(insert("logpush_daily_mau").params.slice(0, 3), [
      "2026-10-13",
      4,
      2,
    ]);
    assert.deepEqual(insert("logpush_daily_stats").params, [
      "2026-10-13",
      2,
      1,
    ]);
    assert.deepEqual(insert("logpush_daily_tool_stats").params, [
      "2026-10-13",
      1,
      1,
      1,
    ]);
    assert.deepEqual(insert("logpush_daily_tool_platform_stats").params, [
      "2026-10-13",
      1,
      7,
      1,
    ]);
    assert.ok(
      writes.some(({ sql }) =>
        sql.startsWith(
          "DELETE FROM logpush_daily_tool_version_stats WHERE date = ?",
        ),
      ),
    );
    assert.ok(!writes.some(({ sql }) => /INTO daily_/.test(sql)));
  });

  it("skips a day without Logpush objects", async () => {
    fakeD1();
    assert.deepEqual(
      await refreshDate(config(fakeR2({})), "2026-10-13", new Map()),
      { date: "2026-10-13", skipped: true },
    );
  });
});
