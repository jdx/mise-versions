#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  appendRegistryOnlyTools,
  buildToolMetadata,
  excludedToolName,
  registryInfoFromEntries,
  summarizeTools,
} from "./sync-to-d1.js";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

describe("sync-to-d1.js", () => {
  it("runs main when invoked by relative script path", () => {
    const result = spawnSync(process.execPath, ["scripts/sync-to-d1.js"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        API_SECRET: "",
        SYNC_API_URL: "",
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /SYNC_API_URL/);
  });

  it("indexes registry shorts and aliases while preserving primary tools", () => {
    const registry = registryInfoFromEntries([
      {
        short: "aws-cli",
        aliases: ["aws", "awscli"],
        backends: ["aqua:aws/aws-cli"],
        description: "AWS CLI",
        security: ["checksum"],
      },
    ]);

    assert.equal(registry.tools.length, 1);
    assert.equal(registry.tools[0].name, "aws-cli");
    assert.deepEqual(registry.tools[0].aliases, ["aws", "awscli"]);
    assert.equal(registry.lookup.get("aws"), registry.lookup.get("aws-cli"));
    assert.equal(registry.lookup.get("awscli"), registry.lookup.get("aws-cli"));
  });

  it("builds registry-only rows with GitHub allowlist metadata", () => {
    const tool = buildToolMetadata(
      "snyk",
      {
        latest_version: null,
        latest_stable_version: null,
        version_count: 0,
        last_updated: null,
      },
      {
        name: "snyk",
        backends: ["aqua:snyk/cli", "github:snyk/cli"],
        description: "Snyk CLI",
        security: [],
      },
    );

    assert.deepEqual(tool, {
      name: "snyk",
      latest_version: null,
      latest_stable_version: null,
      version_count: 0,
      last_updated: null,
      description: "Snyk CLI",
      backends: ["aqua:snyk/cli", "github:snyk/cli"],
      aqua_link:
        "https://github.com/aquaproj/aqua-registry/blob/main/pkgs/snyk/cli/registry.yaml",
      github: "snyk/cli",
      repo_url: "https://github.com/snyk/cli",
    });
  });

  it("appends registry-only tools without replacing TOML-backed rows", () => {
    const tools = [
      {
        name: "act",
        latest_version: "0.2.80",
        latest_stable_version: "0.2.80",
        version_count: 10,
        backends: ["aqua:nektos/act"],
      },
    ];
    const added = appendRegistryOnlyTools(
      tools,
      [
        {
          name: "act",
          backends: ["aqua:nektos/act"],
          description: "Run GitHub Actions locally",
          security: [],
        },
        {
          name: "dasel",
          backends: ["aqua:TomWright/dasel"],
          description: "Data selector",
          security: [],
        },
      ],
      {},
    );

    assert.equal(added, 1);
    assert.equal(tools.length, 2);
    assert.equal(tools[0].version_count, 10);
    assert.deepEqual(tools[1], {
      name: "dasel",
      latest_version: null,
      latest_stable_version: null,
      version_count: 0,
      last_updated: null,
      description: "Data selector",
      backends: ["aqua:TomWright/dasel"],
      aqua_link:
        "https://github.com/aquaproj/aqua-registry/blob/main/pkgs/TomWright/dasel/registry.yaml",
      github: "TomWright/dasel",
      repo_url: "https://github.com/TomWright/dasel",
    });
  });

  it("does not add registry-only rows for existing TOMLs or aliases", () => {
    const tools = [];
    const added = appendRegistryOnlyTools(
      tools,
      [
        {
          name: "aws-cli",
          aliases: ["aws", "awscli"],
          backends: ["aqua:aws/aws-cli"],
          description: "AWS CLI",
          security: [],
        },
        {
          name: "broken-tool",
          aliases: [],
          backends: ["github:example/broken-tool"],
          description: "Has a TOML, but it failed processing",
          security: [],
        },
        {
          name: "snyk",
          aliases: [],
          backends: ["aqua:snyk/cli"],
          description: "Snyk CLI",
          security: [],
        },
      ],
      {},
      new Set(["aws", "broken-tool"]),
    );

    assert.equal(added, 1);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["snyk"],
    );
  });

  it("does not let appended registry aliases suppress registry shorts", () => {
    const tools = [];
    const added = appendRegistryOnlyTools(
      tools,
      [
        {
          name: "main-tool",
          aliases: ["alias-tool"],
          backends: ["github:example/main-tool"],
          description: "Main tool",
          security: [],
        },
        {
          name: "alias-tool",
          aliases: [],
          backends: ["github:example/alias-tool"],
          description: "Separate tool with an overlapping short",
          security: [],
        },
      ],
      {},
    );

    assert.equal(added, 2);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["main-tool", "alias-tool"],
    );
  });

  it("keeps excluded prefixes out of registry-only rows", () => {
    assert.equal(excludedToolName("python-precompiled-linux-arm64"), true);
    assert.equal(excludedToolName("python"), false);

    const tools = [];
    const added = appendRegistryOnlyTools(
      tools,
      [
        {
          name: "python-precompiled-linux-arm64",
          aliases: [],
          backends: ["github:astral-sh/python-build-standalone"],
          description: "internal data file",
          security: [],
        },
      ],
      {},
    );

    assert.equal(added, 0);
    assert.deepEqual(tools, []);
  });

  it("summarizes final manifest fields after registry-only rows are added", () => {
    const summary = summarizeTools([
      {
        name: "node",
        description: "Node.js",
        github: "nodejs/node",
        backends: ["core:node"],
      },
      {
        name: "cargo-tool",
        backends: ["cargo:cargo-tool"],
        package_urls: { cargo: "https://crates.io/crates/cargo-tool" },
      },
    ]);

    assert.deepEqual(summary, {
      withGithub: 1,
      withDesc: 1,
      withBackends: 2,
      withPackageUrls: 1,
    });
  });
});
