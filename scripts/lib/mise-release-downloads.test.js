#!/usr/bin/env node
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  MiseReleaseDayAggregator,
  dayCoverage,
  parseMiseReleaseUri,
  writeMiseReleaseDownloads,
} from "./mise-release-downloads.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function record(overrides = {}) {
  return {
    EdgeStartTimestamp: "2026-10-15T12:00:00Z",
    ClientIP: "203.0.113.1",
    ClientRequestHost: "mise.jdx.dev",
    ClientRequestMethod: "GET",
    ClientRequestURI: "/v2026.10.8/mise-v2026.10.8-linux-x64.tar.gz",
    ClientRequestUserAgent: "curl/8.7.1",
    ClientRequestSource: "eyeball",
    EdgeResponseStatus: 200,
    WorkerSubrequest: false,
    ...overrides,
  };
}

describe("parseMiseReleaseUri", () => {
  it("counts the folder's binaries and archives as binaries", () => {
    for (const file of [
      "mise-v2026.10.8-linux-x64",
      "mise-v2026.10.8-linux-arm64-musl",
      "mise-v2026.10.8-linux-armv7-musl.tar.gz",
      "mise-v2026.10.8-linux-x64.tar.xz",
      "mise-v2026.10.8-macos-arm64.tar.zst",
      "mise-v2026.10.8-windows-x64.zip",
      "mise-v2026.10.8-windows-arm64.exe",
    ]) {
      assert.deepEqual(parseMiseReleaseUri(`/v2026.10.8/${file}`), {
        version: "2026.10.8",
        kind: "binary",
      });
    }
    assert.deepEqual(
      parseMiseReleaseUri("/v2026.1.0/mise-v2026.1.0-linux-x64?x=1"),
      { version: "2026.1.0", kind: "binary" },
    );
  });

  it("counts every other file in a release folder as other", () => {
    for (const file of [
      "SHASUMS256.txt",
      "SHASUMS512.asc",
      "install.sh",
      "install.sh.minisig",
      "v2026.10.8.tar.gz.sig",
      "mise-v2026.10.8-linux-x64.tar.gz.sig",
      // a binary filed under another version's folder
      "mise-v2026.10.7-linux-x64",
      "mise-v2026.10.8",
    ]) {
      assert.deepEqual(parseMiseReleaseUri(`/v2026.10.8/${file}`), {
        version: "2026.10.8",
        kind: "other",
      });
    }
  });

  it("ignores anything outside a release folder", () => {
    for (const uri of [
      "/",
      "/install.sh",
      "/SHASUMS256.txt",
      "/v2026.10.8",
      "/v2026.10.8/",
      "/v2026.10/mise-v2026.10-linux-x64",
      "/v1.2.3/mise-v1.2.3-linux-x64",
      "/v2026.10.8-rc.1/mise-v2026.10.8-rc.1-linux-x64",
      "/getting-started.html",
      "/x/v2026.10.8/mise-v2026.10.8-linux-x64",
      null,
    ]) {
      assert.equal(parseMiseReleaseUri(uri), null, String(uri));
    }
  });
});

describe("MiseReleaseDayAggregator", () => {
  it("counts successful requests on the release hosts per version", () => {
    const agg = new MiseReleaseDayAggregator({ date: "2026-10-15" });
    agg.addRecord(record());
    agg.addRecord(record({ ClientRequestHost: "MISE.EN.DEV" }));
    agg.addRecord(record({ ClientRequestMethod: "HEAD" }));
    agg.addRecord(record({ EdgeResponseStatus: 304 }));
    agg.addRecord(record({ ClientRequestURI: "/v2026.10.8/SHASUMS256.txt" }));
    agg.addRecord(
      record({
        ClientRequestURI: "/v2026.9.0/mise-v2026.9.0-macos-arm64",
        ClientRequestUserAgent: "mise/2026.10.8 macos-arm64 (2026-10-10)",
      }),
    );

    // not counted
    agg.addRecord(record({ EdgeResponseStatus: 404 }));
    agg.addRecord(record({ ClientRequestMethod: "POST" }));
    agg.addRecord(record({ ClientRequestHost: "mise-versions.jdx.dev" }));
    agg.addRecord(record({ WorkerSubrequest: true }));
    agg.addRecord(record({ EdgeStartTimestamp: "2026-10-14T23:59:59Z" }));
    agg.addRecord(record({ EdgeStartTimestamp: "2026-10-16T00:00:00Z" }));
    agg.addRecord(record({ ClientRequestURI: "/install.sh" }));

    assert.deepEqual(agg.rows(), [
      { version: "2026.10.8", binary: 4, other: 1 },
      { version: "2026.9.0", binary: 1, other: 0 },
    ]);
    assert.deepEqual(agg.stats, {
      requests: 6,
      binaryRequests: 5,
      otherRequests: 1,
    });
  });

  it("prefilters raw lines by host and tolerates junk", () => {
    const agg = new MiseReleaseDayAggregator({ date: "2026-10-15" });
    agg.addLine(JSON.stringify(record()));
    agg.addLine(JSON.stringify(record({ ClientRequestHost: "jdx.dev" })));
    agg.addLine('{"ClientRequestHost":"mise.jdx.dev"');
    agg.addLine("");
    assert.deepEqual(agg.rows(), [
      { version: "2026.10.8", binary: 1, other: 0 },
    ]);
  });
});

describe("dayCoverage", () => {
  const stamp = (ms) =>
    new Date(ms)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
  // Logpush-style objects with `minutes`-long windows from `from` to `to`.
  const objects = (zone, from, to, minutes = 1) => {
    const list = [];
    for (
      let start = Date.parse(from);
      start < Date.parse(to);
      start += minutes * 60_000
    ) {
      list.push({
        zone,
        key: `http_requests/${zone}/x/${stamp(start)}_${stamp(start + minutes * 60_000)}_abc.log.gz`,
      });
    }
    return list;
  };
  const fullDay = (zone) =>
    objects(zone, "2026-10-14T23:58:00Z", "2026-10-16T00:02:00Z");

  it("accepts zones whose objects cover the whole day", () => {
    const coverage = dayCoverage(
      [
        ...fullDay("jdx.dev"),
        // en.dev batches every 10 minutes: below the 15-minute limit
        ...objects(
          "en.dev",
          "2026-10-15T00:05:00Z",
          "2026-10-15T23:50:00Z",
          5,
        ).filter((_, i) => i % 2 === 0),
      ],
      ["jdx.dev", "en.dev"],
      "2026-10-15",
    );
    assert.equal(coverage.complete, true);
    assert.deepEqual(coverage.zones["jdx.dev"], {
      objects: 1444,
      firstStart: "2026-10-14T23:58:00.000Z",
      lastEnd: "2026-10-16T00:02:00.000Z",
      largestGapSeconds: 0,
    });
    assert.equal(coverage.zones["en.dev"].largestGapSeconds, 600);
  });

  it("rejects a day with a hole in the middle", () => {
    // Logpush paused from 11:00 to 11:30, or those objects were lost.
    const outage = [
      ...objects("jdx.dev", "2026-10-14T23:58:00Z", "2026-10-15T11:00:00Z"),
      ...objects("jdx.dev", "2026-10-15T11:30:00Z", "2026-10-16T00:02:00Z"),
    ];
    const coverage = dayCoverage(outage, ["jdx.dev"], "2026-10-15");
    assert.equal(coverage.complete, false);
    assert.equal(coverage.zones["jdx.dev"].largestGapSeconds, 30 * 60);
    assert.equal(
      coverage.zones["jdx.dev"].firstStart,
      "2026-10-14T23:58:00.000Z",
    );
  });

  it("does not count neighbouring days' objects that only cross midnight", () => {
    // The day's own folder is empty; only batches crossing into and out of
    // it were listed from the neighbouring folders.
    const neighbours = [
      ...objects("jdx.dev", "2026-10-14T23:58:00Z", "2026-10-15T00:02:00Z"),
      ...objects("jdx.dev", "2026-10-15T23:58:00Z", "2026-10-16T00:02:00Z"),
    ];
    const coverage = dayCoverage(neighbours, ["jdx.dev"], "2026-10-15");
    assert.equal(coverage.complete, false);
    assert.equal(coverage.zones["jdx.dev"].largestGapSeconds, 86400 - 4 * 60);
  });

  it("rejects a day that starts late, ends early, or misses a zone", () => {
    // The Logpush jobs were created at about 14:54 UTC on 2026-10-14.
    const late = objects(
      "jdx.dev",
      "2026-10-14T14:54:00Z",
      "2026-10-15T00:02:00Z",
    );
    assert.equal(dayCoverage(late, ["jdx.dev"], "2026-10-14").complete, false);
    const early = objects(
      "jdx.dev",
      "2026-10-14T23:58:00Z",
      "2026-10-15T20:00:00Z",
    );
    assert.equal(dayCoverage(early, ["jdx.dev"], "2026-10-15").complete, false);
    const missing = dayCoverage(
      fullDay("jdx.dev"),
      ["jdx.dev", "en.dev"],
      "2026-10-15",
    );
    assert.equal(missing.complete, false);
    assert.deepEqual(missing.zones["en.dev"], {
      objects: 0,
      firstStart: null,
      lastEnd: null,
      largestGapSeconds: 86400,
    });
  });
});

describe("writeMiseReleaseDownloads", () => {
  function fakeD1() {
    const writes = [];
    globalThis.fetch = async (_url, options) => {
      writes.push(JSON.parse(options.body));
      return new Response(
        JSON.stringify({ success: true, result: [{ success: true }] }),
      );
    };
    return writes;
  }
  const config = {
    cloudflareAccountId: "acct",
    cloudflareApiToken: "token",
    analyticsDbId: "db",
  };

  function aggregator() {
    const agg = new MiseReleaseDayAggregator({ date: "2026-10-15" });
    agg.addRecord(record());
    agg.addRecord(record({ ClientRequestURI: "/v2026.10.8/install.sh" }));
    agg.addRecord(
      record({ ClientRequestURI: "/v2026.9.0/mise-v2026.9.0-linux-x64" }),
    );
    return agg;
  }

  it("marks a complete day covered only after its rows are replaced", async () => {
    const writes = fakeD1();
    await writeMiseReleaseDownloads(
      config,
      "2026-10-15",
      aggregator(),
      true,
      "2026-10-16T02:30:00.000Z",
    );
    assert.deepEqual(
      writes.map(({ sql }) => sql.split(" (")[0]),
      [
        "DELETE FROM mise_release_download_days WHERE date = ?",
        "DELETE FROM mise_release_daily_downloads WHERE date = ?",
        "INSERT OR REPLACE INTO mise_release_daily_downloads",
        "INSERT OR REPLACE INTO mise_release_download_days",
      ],
    );
    assert.deepEqual(writes[2].params, [
      "2026-10-15",
      "2026.10.8",
      1,
      1,
      "2026-10-15",
      "2026.9.0",
      1,
      0,
    ]);
    assert.deepEqual(writes[3].params, [
      "2026-10-15",
      2,
      1,
      "2026-10-16T02:30:00.000Z",
    ]);
  });

  it("stores a partial day's rows without marking it covered", async () => {
    const writes = fakeD1();
    await writeMiseReleaseDownloads(
      config,
      "2026-10-14",
      aggregator(),
      false,
      "2026-10-15T02:30:00.000Z",
    );
    assert.equal(
      writes[0].sql.startsWith("DELETE FROM mise_release_download_days"),
      true,
    );
    assert.ok(
      !writes.some(({ sql }) =>
        sql.startsWith("INSERT OR REPLACE INTO mise_release_download_days"),
      ),
    );
  });
});
