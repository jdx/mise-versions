#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendRegistryOnlyTools,
  buildToolMetadata,
  registryInfoFromEntries,
  summarizeTools,
} from "./sync-to-d1.js";

describe("sync-to-d1.js", () => {
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
