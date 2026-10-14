#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LogpushDayAggregator,
  hashIp,
  isClientRequest,
  logpushDayPrefixes,
  objectOverlapsDate,
  parseBeaconUri,
  parseLogpushObjectWindow,
  parseMiseUserAgent,
  recordTimeMs,
} from "./logpush.js";

const SECRET = "test-secret";
const UA = "mise/2026.10.10 linux-x64 (2026-10-11) bash";

function record(overrides = {}) {
  return {
    EdgeStartTimestamp: "2026-10-13T12:00:00Z",
    ClientIP: "203.0.113.1",
    ClientRequestHost: "mise-versions.jdx.dev",
    ClientRequestMethod: "GET",
    ClientRequestURI: "/data/node.toml",
    ClientRequestUserAgent: UA,
    ClientRequestSource: "eyeball",
    EdgeResponseStatus: 200,
    WorkerSubrequest: false,
    ...overrides,
  };
}

function beacon(params) {
  return `/t?${new URLSearchParams(params)}`;
}

describe("parseMiseUserAgent", () => {
  it("parses mise clients and the trailing CI token", () => {
    assert.deepEqual(parseMiseUserAgent(UA), {
      version: "2026.10.10",
      ci: false,
    });
    assert.deepEqual(parseMiseUserAgent(`${UA} ci`), {
      version: "2026.10.10",
      ci: true,
    });
    assert.deepEqual(parseMiseUserAgent(`${UA} ci \n`), {
      version: "2026.10.10",
      ci: true,
    });
  });

  it("rejects other clients and does not mistake a ci-suffixed word", () => {
    assert.equal(parseMiseUserAgent("curl/8.0"), null);
    assert.equal(parseMiseUserAgent("Mozilla/5.0 mise/1.0"), null);
    assert.equal(parseMiseUserAgent(undefined), null);
    assert.equal(
      parseMiseUserAgent("mise/2026.1.0 linux-x64 zsh-ci").ci,
      false,
    );
    assert.equal(parseMiseUserAgent("mise/2026.1.0 linux-x64 posix").ci, false);
  });
});

describe("record filters", () => {
  it("keeps eyeball requests only", () => {
    assert.equal(isClientRequest(record()), true);
    assert.equal(
      isClientRequest(record({ ClientRequestSource: undefined })),
      true,
    );
    assert.equal(isClientRequest(record({ WorkerSubrequest: true })), false);
    assert.equal(
      isClientRequest(record({ ClientRequestSource: "edgeWorkerFetch" })),
      false,
    );
  });

  it("reads RFC3339 and numeric timestamps", () => {
    const ms = Date.parse("2026-10-13T12:00:00Z");
    assert.equal(recordTimeMs(record()), ms);
    assert.equal(recordTimeMs(record({ EdgeStartTimestamp: ms / 1000 })), ms);
    assert.equal(
      recordTimeMs(record({ EdgeStartTimestamp: `${ms}000000` })),
      ms,
    );
    assert.equal(recordTimeMs(record({ EdgeStartTimestamp: "nope" })), null);
  });

  it("hashes IPs like web/src/lib/hash.ts", () => {
    const hash = hashIp("203.0.113.1", SECRET);
    assert.equal(hash, "5076d4960826"); // also asserted in web/src/lib/mise-client.test.ts
    assert.equal(hash, hashIp("203.0.113.1", SECRET));
    assert.notEqual(hash, hashIp("203.0.113.1", "other"));
  });
});

describe("parseBeaconUri", () => {
  it("parses URL-encoded beacon parameters", () => {
    assert.deepEqual(
      parseBeaconUri(
        "/t?tool=node&full=core%3Anode&version=22.1.0&os=linux&arch=x64",
      ),
      {
        tool: "node",
        version: "22.1.0",
        full: "core:node",
        os: "linux",
        arch: "x64",
      },
    );
    assert.deepEqual(
      parseBeaconUri(
        beacon({ tool: "aqua/cli", version: "1.0 beta+1", full: "aqua:a/b" }),
      ),
      {
        tool: "aqua/cli",
        version: "1.0 beta+1",
        full: "aqua:a/b",
        os: null,
        arch: null,
      },
    );
  });

  it("rejects other paths and incomplete beacons", () => {
    assert.equal(parseBeaconUri("/t"), null);
    assert.equal(parseBeaconUri("/t?tool=node"), null);
    assert.equal(parseBeaconUri("/tools?tool=node&version=1"), null);
    assert.equal(parseBeaconUri("/t/?tool=node&version=1"), null);
    assert.equal(parseBeaconUri(`/t?tool=${"x".repeat(300)}&version=1`), null);
    assert.equal(parseBeaconUri("/t?tool=no%0Ade&version=1"), null);
  });
});

describe("Logpush object selection", () => {
  it("parses object windows", () => {
    assert.deepEqual(
      parseLogpushObjectWindow(
        "http_requests/jdx.dev/20261013/20261013T235500Z_20261014T000100Z_ab12.log.gz",
      ),
      {
        startMs: Date.parse("2026-10-13T23:55:00Z"),
        endMs: Date.parse("2026-10-14T00:01:00Z"),
      },
    );
    assert.equal(parseLogpushObjectWindow("x/y/other.gz"), null);
  });

  it("lists neighbouring folders and keeps overlapping objects", () => {
    assert.deepEqual(
      logpushDayPrefixes("http_requests", "jdx.dev", "2026-10-01").map(
        (p) => p.prefix,
      ),
      [
        "http_requests/jdx.dev/20260930/",
        "http_requests/jdx.dev/20261001/",
        "http_requests/jdx.dev/20261002/",
      ],
    );
    const crossing = "20261013T235500Z_20261014T000100Z_a.log.gz";
    assert.equal(
      objectOverlapsDate(crossing, "2026-10-13", "2026-10-14"),
      true,
    );
    assert.equal(
      objectOverlapsDate(crossing, "2026-10-13", "2026-10-13"),
      true,
    );
    assert.equal(
      objectOverlapsDate(
        "20261012T100000Z_20261012T100500Z_a.log.gz",
        "2026-10-12",
        "2026-10-13",
      ),
      false,
    );
    assert.equal(
      objectOverlapsDate("odd.gz", "2026-10-13", "2026-10-13"),
      true,
    );
    assert.equal(
      objectOverlapsDate("odd.gz", "2026-10-12", "2026-10-13"),
      false,
    );
  });
});

describe("LogpushDayAggregator", () => {
  function aggregator() {
    return new LogpushDayAggregator({ date: "2026-10-13", secret: SECRET });
  }

  it("counts distinct non-CI mise users across hosts and paths", () => {
    const agg = aggregator();
    agg.addRecord(record());
    agg.addRecord(record({ ClientRequestURI: "/data/python.toml" }));
    agg.addRecord(record({ ClientRequestHost: "mise.jdx.dev" }));
    agg.addRecord(record({ ClientIP: "203.0.113.2" }));
    // excluded
    agg.addRecord(
      record({ ClientIP: "203.0.113.3", ClientRequestUserAgent: `${UA} ci` }),
    );
    agg.addRecord(record({ ClientIP: "203.0.113.4", WorkerSubrequest: true }));
    agg.addRecord(
      record({ ClientIP: "203.0.113.5", ClientRequestUserAgent: "curl/8" }),
    );
    agg.addRecord(
      record({
        ClientIP: "203.0.113.6",
        EdgeStartTimestamp: "2026-10-14T00:00:00Z",
      }),
    );
    assert.equal(agg.users.size, 2);
    assert.equal(agg.stats.miseRequests, 4);
    assert.equal(agg.stats.ciRequests, 1);
    assert.deepEqual(
      [...agg.userHashes()],
      ["203.0.113.1", "203.0.113.2"]
        .map((ip) => parseInt(hashIp(ip, SECRET), 16))
        .sort((a, b) => a - b),
    );
  });

  it("restricts to configured hosts", () => {
    const agg = new LogpushDayAggregator({
      date: "2026-10-13",
      secret: SECRET,
      hosts: ["mise-versions.jdx.dev"],
    });
    agg.addRecord(record({ ClientRequestHost: "other.jdx.dev" }));
    assert.equal(agg.users.size, 0);
    agg.addRecord(record({ ClientRequestHost: "MISE-VERSIONS.jdx.dev" }));
    assert.equal(agg.users.size, 1);
  });

  it("prefilters lines without a mise user agent", () => {
    const agg = aggregator();
    agg.addLine(JSON.stringify(record({ ClientRequestUserAgent: "curl/8" })));
    agg.addLine("{not json mise/");
    agg.addLine('{"ClientRequestUserAgent":"mise/1" broken');
    agg.addLine(JSON.stringify(record()));
    agg.addLine("");
    assert.equal(agg.stats.lines, 4);
    assert.equal(agg.stats.malformed, 1);
    assert.equal(agg.users.size, 1);
  });

  it("dedupes downloads per user, tool, and version, keeping the newest platform", () => {
    const agg = aggregator();
    const install = (ip, time, params, extra = {}) =>
      agg.addRecord(
        record({
          ClientIP: ip,
          EdgeStartTimestamp: `2026-10-13T${time}Z`,
          ClientRequestURI: beacon(params),
          ...extra,
        }),
      );
    install("10.0.0.1", "01:00:00", {
      tool: "node",
      version: "22",
      full: "core:node",
      os: "linux",
      arch: "x64",
    });
    install("10.0.0.1", "05:00:00", {
      tool: "node",
      version: "22",
      full: "core:node",
      os: "linux",
      arch: "arm64",
    });
    // Out of order: older than the 05:00 request, so it must not win.
    install("10.0.0.1", "03:00:00", {
      tool: "node",
      version: "22",
      full: "core:node",
      os: "macos",
      arch: "arm64",
    });
    install("10.0.0.1", "06:00:00", {
      tool: "node",
      version: "20",
      full: "core:node",
      os: "linux",
      arch: "x64",
    });
    install("10.0.0.2", "07:00:00", {
      tool: "node",
      version: "22",
      os: "linux",
      arch: "x64",
    });
    install("10.0.0.2", "08:00:00", {
      tool: "jq",
      version: "1.7",
      full: "aqua:jqlang/jq",
    });
    // Not counted: CI, failed response, POST, wrong host.
    install(
      "10.0.0.3",
      "09:00:00",
      { tool: "jq", version: "1.7" },
      { ClientRequestUserAgent: `${UA} ci` },
    );
    install(
      "10.0.0.4",
      "09:00:00",
      { tool: "jq", version: "1.7" },
      { EdgeResponseStatus: 404 },
    );
    install(
      "10.0.0.5",
      "09:00:00",
      { tool: "jq", version: "1.7" },
      { ClientRequestMethod: "POST" },
    );
    install(
      "10.0.0.6",
      "09:00:00",
      { tool: "jq", version: "1.7" },
      { ClientRequestHost: "mise.jdx.dev" },
    );

    const rollups = agg.downloadRollups();
    assert.equal(rollups.total, 4);
    assert.equal(rollups.uniqueUsers, 2);
    assert.equal(agg.stats.ciBeaconRequests, 1);
    const byTool = Object.fromEntries(rollups.tools.map((r) => [r.tool, r]));
    assert.deepEqual(byTool.node, {
      tool: "node",
      downloads: 3,
      unique_users: 2,
    });
    assert.deepEqual(byTool.jq, { tool: "jq", downloads: 1, unique_users: 1 });
    assert.deepEqual(
      rollups.backends.sort((a, b) =>
        a.backend_type.localeCompare(b.backend_type),
      ),
      [
        { backend_type: "aqua", downloads: 1, unique_users: 1 },
        { backend_type: "core", downloads: 2, unique_users: 1 },
        { backend_type: "unknown", downloads: 1, unique_users: 1 },
      ],
    );
    assert.deepEqual(
      rollups.versions.sort((a, b) =>
        `${a.tool}${a.version}`.localeCompare(`${b.tool}${b.version}`),
      ),
      [
        { tool: "jq", version: "1.7", downloads: 1 },
        { tool: "node", version: "20", downloads: 1 },
        { tool: "node", version: "22", downloads: 2 },
      ],
    );
    const platforms = rollups.platforms
      .map((r) => `${r.tool}:${r.os}/${r.arch}=${r.downloads}`)
      .sort();
    assert.deepEqual(platforms, [
      "jq:/=1",
      "node:linux/arm64=1",
      "node:linux/x64=2",
    ]);
    assert.equal(
      rollups.toolBackends.find(
        (r) => r.tool === "node" && r.backend_type === "core",
      ).downloads,
      2,
    );
  });
});

describe("GitHub versions demand", () => {
  it("collects baked list paths mise fetched, CI included", () => {
    const aggregator = new LogpushDayAggregator({
      date: "2026-10-13",
      secret: SECRET,
    });
    aggregator.addRecord(
      record({ ClientRequestURI: "/data/github/cli/cli/releases.json" }),
    );
    aggregator.addRecord(
      record({
        ClientRequestURI: "/data/github/apache/tomcat/tags.json?x=1",
        ClientRequestUserAgent: `${UA} ci`,
      }),
    );
    // Not served, not GET, another host, or not a list.
    aggregator.addRecord(
      record({
        ClientRequestURI: "/data/github/o/missing/releases.json",
        EdgeResponseStatus: 404,
      }),
    );
    aggregator.addRecord(
      record({
        ClientRequestURI: "/data/github/o/head/releases.json",
        ClientRequestMethod: "HEAD",
      }),
    );
    aggregator.addRecord(
      record({
        ClientRequestURI: "/data/github/o/elsewhere/releases.json",
        ClientRequestHost: "example.com",
      }),
    );
    aggregator.addRecord(record({ ClientRequestURI: "/data/node.toml" }));
    assert.deepEqual([...aggregator.githubVersionsPaths].sort(), [
      "/data/github/apache/tomcat/tags.json",
      "/data/github/cli/cli/releases.json",
    ]);
  });
});
