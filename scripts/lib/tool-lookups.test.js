#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ToolLookupDay,
  lookupTools,
  misePlatform,
  registryRepoTools,
  sendsBeacon,
} from "./tool-lookups.js";

const REGISTRY = [
  "gh                            aqua:cli/cli github:cli/cli",
  "1password                     vfox:jdx/vfox-1password aqua:1password/cli",
  "1password-cli                 vfox:jdx/vfox-1password aqua:1password/cli",
  "ripgrep                       aqua:BurntSushi/ripgrep ubi:BurntSushi/ripgrep[exe=rg]",
  "node                          core:node",
  "",
].join("\n");

describe("registryRepoTools", () => {
  it("maps each GitHub repo a backend uses to its tools, once each", () => {
    const repos = registryRepoTools(REGISTRY);
    assert.deepEqual(repos.get("cli/cli"), ["gh"]);
    assert.deepEqual(repos.get("1password/cli"), [
      "1password",
      "1password-cli",
    ]);
    assert.deepEqual(repos.get("burntsushi/ripgrep"), ["ripgrep"]);
    assert.equal(repos.has("jdx/vfox-1password"), false);
    assert.equal(repos.size, 3);
  });
});

describe("lookupTools", () => {
  const repos = registryRepoTools(REGISTRY);
  const host = "mise-versions.jdx.dev";

  it("names the tool of a version list", () => {
    assert.deepEqual(lookupTools(host, "/data/node.toml", repos), ["node"]);
    assert.deepEqual(lookupTools(host, "/tools/node.toml", repos), ["node"]);
    assert.deepEqual(
      lookupTools("mise-tools.jdx.dev", "/data/cargo%3Aripgrep.toml", repos),
      ["cargo:ripgrep"],
    );
  });

  it("credits GitHub lists and mirror requests to registry tools", () => {
    assert.deepEqual(
      lookupTools(host, "/data/github/BurntSushi/ripgrep/releases.json", repos),
      ["ripgrep"],
    );
    assert.deepEqual(
      lookupTools(
        host,
        "/api/github/repos/cli/cli/releases/tags/v2.0.0",
        repos,
      ),
      ["gh"],
    );
    // No registry tool uses it.
    assert.deepEqual(
      lookupTools(host, "/data/github/someone/thing/releases.json", repos),
      [],
    );
  });

  it("counts mise-java as java and ignores everything else", () => {
    assert.deepEqual(
      lookupTools("mise-java.jdx.dev", "/jvm/ga/linux/x86_64.json", repos),
      ["java"],
    );
    assert.deepEqual(lookupTools(host, "/t", repos), []);
    assert.deepEqual(lookupTools(host, "/data/index.v1.json", repos), []);
    assert.deepEqual(lookupTools(host, "/data/a/b.toml", repos), []);
    assert.deepEqual(lookupTools(host, "/data/%E0%A4%A.toml", repos), []);
    assert.deepEqual(lookupTools("mise.jdx.dev", "/data/node.toml", repos), []);
  });
});

describe("misePlatform", () => {
  it("reads os and arch from the user agent", () => {
    assert.deepEqual(
      misePlatform("mise/2026.10.10 linux-x64 (2026-10-11) bash"),
      { os: "linux", arch: "x64" },
    );
    assert.deepEqual(
      misePlatform("mise/2026.11.3 macos-arm64 (2026-11-20) zsh ci"),
      { os: "macos", arch: "arm64" },
    );
    assert.deepEqual(misePlatform("mise/2026.1.0"), { os: "", arch: "" });
    assert.deepEqual(misePlatform("mise/2026.1.0 (2026-01-01)"), {
      os: "",
      arch: "",
    });
  });
});

describe("sendsBeacon", () => {
  it("is true from 2026.10.11 on", () => {
    assert.equal(sendsBeacon("2026.10.10"), false);
    assert.equal(sendsBeacon("2026.9.30"), false);
    assert.equal(sendsBeacon("2026.10.11"), true);
    assert.equal(sendsBeacon("2026.11.0"), true);
    assert.equal(sendsBeacon("2027.1.0"), true);
    assert.equal(sendsBeacon("nonsense"), false);
  });
});

describe("ToolLookupDay", () => {
  it("counts each machine once per tool and platform", () => {
    const day = new ToolLookupDay();
    const linux = { os: "linux", arch: "x64" };
    day.add(1, ["node"], linux, true);
    day.add(1, ["node"], linux, true);
    day.add(2, ["node"], { os: "macos", arch: "arm64" }, false);
    day.add(2, ["1password", "1password-cli"], linux, false);
    day.add(3, [], linux, true);
    const rollups = day.rollups();
    assert.equal(rollups.uniqueUsers, 2);
    assert.equal(rollups.requests, 5);
    assert.deepEqual(
      rollups.tools.find((row) => row.tool === "node"),
      { tool: "node", unique_users: 2, beacon_client_users: 1, requests: 3 },
    );
    assert.equal(rollups.tools.length, 3);
    assert.deepEqual(
      rollups.platforms.filter((row) => row.tool === "node"),
      [
        { tool: "node", os: "linux", arch: "x64", unique_users: 1 },
        { tool: "node", os: "macos", arch: "arm64", unique_users: 1 },
      ],
    );
  });
});
