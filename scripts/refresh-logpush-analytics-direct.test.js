#!/usr/bin/env node
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { afterEach, describe, it } from "node:test";
import {
  forEachLine,
  laterMauDates,
  parseArgs,
  recomputeLaterMau,
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

function fakeD1({ mauRows = {} } = {}) {
  const writes = [];
  const tools = [
    { id: 1, name: "node" },
    { id: 2, name: "jq" },
  ];
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/d1\/database\/db\/query$/);
    const { sql, params } = JSON.parse(options.body);
    writes.push({ sql, params });
    let results = [];
    if (sql.startsWith("SELECT id, name FROM tools")) {
      results = tools;
    } else if (sql.startsWith("INSERT OR IGNORE INTO tools")) {
      for (const name of params) {
        if (!tools.some((tool) => tool.name === name)) {
          tools.push({ id: tools.length + 1, name });
        }
      }
    } else if (sql.startsWith("SELECT id, os, arch FROM platforms")) {
      results = [{ id: 7, os: "linux", arch: "x64" }];
    } else if (sql.startsWith("SELECT days_covered FROM logpush_daily_mau")) {
      results = mauRows[params[0]] ? [mauRows[params[0]]] : [];
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
    assert.equal(
      await forEachLine(gzipSync("a\nb\n\nc"), (l) => seen.push(l)),
      6,
    );
    assert.equal(
      await forEachLine(Buffer.from("d\ne\n"), (l) => seen.push(l)),
      4,
    );
    assert.deepEqual(seen, ["a", "b", "", "c", "d", "e"]);
  });

  it("keeps multi-byte characters split across chunks intact", async () => {
    const seen = [];
    const text = `${"x".repeat(70000)}\u00e9\nz`;
    const bytes = await forEachLine(gzipSync(text), (l) => seen.push(l));
    assert.equal(bytes, Buffer.byteLength(text));
    assert.deepEqual(seen, [`${"x".repeat(70000)}\u00e9`, "z"]);
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
    assert.equal(result.capacity.date, "2026-10-13");
    assert.equal(result.capacity.objects, 2);
    assert.ok(result.capacity.lines > 0);
    assert.ok(
      result.capacity.uncompressedBytes >= result.capacity.compressedBytes,
    );
    assert.ok(result.capacity.readMs >= 0);

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
    // The stats row marks the download tables complete: cleared first,
    // written after every dimension table.
    const statsClear = writes.findIndex(({ sql }) =>
      sql.startsWith("DELETE FROM logpush_daily_stats"),
    );
    const statsWrite = writes.findIndex(({ sql }) =>
      sql.startsWith("INSERT OR REPLACE INTO logpush_daily_stats "),
    );
    const dimensionWrites = writes
      .map(({ sql }, index) => (/logpush_daily_tool_/.test(sql) ? index : -1))
      .filter((index) => index >= 0);
    assert.ok(statsClear >= 0 && statsClear < Math.min(...dimensionWrites));
    assert.ok(statsWrite > Math.max(...dimensionWrites));
    // unknown-tool is created like the Worker's getOrCreateToolId would.
    assert.deepEqual(
      writes.find(({ sql }) => sql.startsWith("INSERT OR IGNORE INTO tools"))
        .params,
      ["unknown-tool"],
    );
    assert.deepEqual(insert("logpush_daily_tool_stats").params, [
      "2026-10-13",
      1,
      1,
      1,
      "2026-10-13",
      3,
      1,
      1,
    ]);
    assert.deepEqual(insert("logpush_daily_tool_platform_stats").params, [
      "2026-10-13",
      1,
      7,
      1,
      "2026-10-13",
      3,
      0, // no os/arch: unknown platform
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

  it("lists the later days whose MAU a refresh changes", () => {
    assert.deepEqual(
      laterMauDates(["2026-10-12", "2026-10-13"], "2026-10-13"),
      [],
    );
    assert.deepEqual(laterMauDates(["2026-10-10"], "2026-10-13"), [
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
    ]);
    const later = laterMauDates(["2026-09-01"], "2026-12-31");
    assert.equal(later.length, 29);
    assert.equal(later.at(-1), "2026-09-30");
  });

  it("recomputes later MAU from stored user sets after a backfill", async () => {
    const set = (values) => encodeUserHashes(Float64Array.from(values));
    const r2 = fakeR2({
      "rollups/mise-users/v1/2026-10-10.bin.gz": set([1, 2]),
      // 2026-10-11 has no Logpush data, so it gets no MAU row
      "rollups/mise-users/v1/2026-10-12.bin.gz": set([2, 3]),
      "rollups/mise-users/v1/2026-10-13.bin.gz": set([4]),
    });
    const writes = fakeD1();
    const results = await recomputeLaterMau(
      config(r2),
      ["2026-10-10"],
      new Map(),
      "2026-10-13",
    );
    assert.deepEqual(results, [
      { date: "2026-10-12", mau: 3, mauDaysCovered: 2 },
      { date: "2026-10-13", mau: 4, mauDaysCovered: 3 },
    ]);
    assert.deepEqual(
      writes
        .filter(({ sql }) => sql.startsWith("INSERT"))
        .map(({ params }) => params.slice(0, 3)),
      [
        ["2026-10-12", 3, 2],
        ["2026-10-13", 4, 3],
      ],
    );
  });

  it("keeps a stored MAU row when user sets in its window have gone missing", async () => {
    const set = (values) => encodeUserHashes(Float64Array.from(values));
    const r2 = fakeR2({
      "rollups/mise-users/v1/2026-10-10.bin.gz": set([1, 2]),
      "rollups/mise-users/v1/2026-10-12.bin.gz": set([2, 3]),
      "rollups/mise-users/v1/2026-10-13.bin.gz": set([4]),
    });
    // 2026-10-13 was computed when 5 days of sets existed.
    const writes = fakeD1({
      mauRows: {
        "2026-10-12": { days_covered: 2 },
        "2026-10-13": { days_covered: 5 },
      },
    });
    const results = await recomputeLaterMau(
      config(r2),
      ["2026-10-10"],
      new Map(),
      "2026-10-13",
    );
    assert.deepEqual(results, [
      { date: "2026-10-12", mau: 3, mauDaysCovered: 2 },
    ]);
    assert.deepEqual(
      writes
        .filter(({ sql }) => sql.startsWith("INSERT"))
        .map(({ params }) => params[0]),
      ["2026-10-12"],
    );
  });

  it("recomputes later MAU in a dry run without touching D1", async () => {
    const set = (values) => encodeUserHashes(Float64Array.from(values));
    const r2 = fakeR2({
      "rollups/mise-users/v1/2026-10-10.bin.gz": set([1, 2]),
      "rollups/mise-users/v1/2026-10-11.bin.gz": set([3]),
    });
    globalThis.fetch = async () => {
      throw new Error("D1 must not be called in a dry run");
    };
    const results = await recomputeLaterMau(
      { ...config(r2), cloudflareApiToken: undefined, dryRun: true },
      ["2026-10-10"],
      new Map(),
      "2026-10-11",
    );
    assert.deepEqual(results, [
      { date: "2026-10-11", mau: 3, mauDaysCovered: 2 },
    ]);
  });

  it("keeps a day's stored MAU when refreshing it with fewer user sets", async () => {
    const r2 = fakeR2({
      "http_requests/jdx.dev/20261013/20261013T000000Z_20261013T120000Z_a.log.gz":
        gzipSync(line({})),
    });
    const writes = fakeD1({ mauRows: { "2026-10-13": { days_covered: 5 } } });
    const result = await refreshDate(config(r2), "2026-10-13", new Map());
    assert.equal(result.mauDaysCovered, 1);
    const inserts = writes
      .filter(({ sql }) => sql.startsWith("INSERT OR REPLACE INTO"))
      .map(({ sql }) => sql.split(" ")[4]);
    assert.ok(inserts.includes("logpush_daily_dau"));
    assert.ok(!inserts.includes("logpush_daily_mau"));
  });

  it("counts mise release downloads from every release zone", async () => {
    const release = (overrides) =>
      line({
        EdgeStartTimestamp: "2026-10-15T12:00:00Z",
        ClientRequestHost: "mise.jdx.dev",
        ClientRequestURI: "/v2026.10.8/mise-v2026.10.8-linux-x64.tar.gz",
        ClientRequestUserAgent: "curl/8.7.1",
        ...overrides,
      });
    const r2 = fakeR2({
      "http_requests/jdx.dev/20261015/20261015T000000Z_20261015T120000Z_a.log.gz":
        gzipSync(
          [
            line({ EdgeStartTimestamp: "2026-10-15T01:00:00Z" }),
            release({}),
            release({ ClientRequestURI: "/v2026.10.8/SHASUMS256.txt" }),
          ].join("\n"),
        ),
      "http_requests/jdx.dev/20261015/20261015T120000Z_20261015T235959Z_b.log.gz":
        gzipSync(release({ EdgeStartTimestamp: "2026-10-15T23:00:00Z" })),
      // en.dev only feeds the release counts, not the mise usage numbers.
      "http_requests/en.dev/20261015/20261015T000000Z_20261015T235959Z_c.log.gz":
        gzipSync(
          [
            release({ ClientRequestHost: "mise.en.dev" }),
            release({
              ClientRequestHost: "mise.en.dev",
              ClientRequestURI: "/v2026.9.0/mise-v2026.9.0-macos-arm64",
              ClientRequestUserAgent: UA,
              ClientIP: "198.51.100.77",
            }),
          ].join("\n"),
        ),
    });
    const writes = fakeD1();
    const result = await refreshDate(
      { ...config(r2), releaseZones: ["jdx.dev", "en.dev"] },
      "2026-10-15",
      new Map(),
    );
    assert.equal(result.dau, 1); // the en.dev mise client is not a user here
    assert.deepEqual(result.miseReleases, {
      complete: true,
      requests: 5,
      binaryRequests: 4,
      otherRequests: 1,
      versions: 2,
    });
    const insert = (table) =>
      writes.find(({ sql }) =>
        sql.startsWith(`INSERT OR REPLACE INTO ${table} `),
      );
    assert.deepEqual(insert("mise_release_daily_downloads").params, [
      "2026-10-15",
      "2026.10.8",
      3,
      1,
      "2026-10-15",
      "2026.9.0",
      1,
      0,
    ]);
    assert.deepEqual(insert("mise_release_download_days").params.slice(0, 3), [
      "2026-10-15",
      4,
      1,
    ]);
  });

  it("does not mark release downloads covered when a zone is missing", async () => {
    const r2 = fakeR2({
      "http_requests/jdx.dev/20261015/20261015T000000Z_20261015T235959Z_a.log.gz":
        gzipSync(line({ EdgeStartTimestamp: "2026-10-15T01:00:00Z" })),
    });
    const writes = fakeD1();
    const result = await refreshDate(
      { ...config(r2), releaseZones: ["jdx.dev", "en.dev"] },
      "2026-10-15",
      new Map(),
    );
    assert.equal(result.miseReleases.complete, false);
    assert.ok(
      writes.some(({ sql }) =>
        sql.startsWith("DELETE FROM mise_release_download_days"),
      ),
    );
    assert.ok(
      !writes.some(({ sql }) =>
        sql.startsWith("INSERT OR REPLACE INTO mise_release_download_days"),
      ),
    );
  });

  it("counts release downloads but stores no usage numbers for a day with only release-zone logs", async () => {
    const r2 = fakeR2({
      "http_requests/en.dev/20261015/20261015T000000Z_20261015T235959Z_c.log.gz":
        gzipSync(
          line({
            EdgeStartTimestamp: "2026-10-15T12:00:00Z",
            ClientRequestHost: "mise.en.dev",
            ClientRequestURI: "/v2026.10.8/mise-v2026.10.8-linux-x64",
          }),
        ),
    });
    const writes = fakeD1();
    const userSets = new Map();
    const result = await refreshDate(
      { ...config(r2), releaseZones: ["jdx.dev", "en.dev"] },
      "2026-10-15",
      userSets,
    );
    assert.equal(result.usageSkipped, true);
    assert.equal(result.dau, undefined);
    assert.equal(result.miseReleases.binaryRequests, 1);
    // jdx.dev has no logs that day, so the release counts are not covered.
    assert.equal(result.miseReleases.complete, false);
    // No user set, MAU, DAU, or install rows for the missing usage logs.
    assert.equal(userSets.size, 0);
    assert.ok(![...r2.store.keys()].some((key) => key.startsWith("rollups/")));
    assert.ok(!writes.some(({ sql }) => /logpush_/.test(sql)));
    assert.deepEqual(
      writes.find(({ sql }) =>
        sql.startsWith("INSERT OR REPLACE INTO mise_release_daily_downloads"),
      ).params,
      ["2026-10-15", "2026.10.8", 1, 0],
    );
  });
});
