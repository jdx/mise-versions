import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runGenerationTest(source) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-"],
    {
      cwd: new URL("..", import.meta.url),
      input: source,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
}

test("catalog sync rotates one latest generation per GitHub repository", () => {
  runGenerationTest(`
    import assert from "node:assert/strict";
    import {
      getGitHubLatestReleaseGeneration,
      rotateGitHubLatestReleaseGenerations,
    } from "./web/src/lib/github/release-generation.ts";

    const values = new Map();
    const writes = [];
    const cache = {
      get: async (key) => values.get(key) ?? null,
      put: async (key, value) => {
        writes.push({ key, value });
        values.set(key, value);
      },
    };
    const count = await rotateGitHubLatestReleaseGenerations(cache, [
      {
        versions: [
          { release_url: "https://github.com/Owner/Repo/releases/tag/v1.0.0" },
          { release_url: "https://github.com/owner/repo/releases/tag/v1.1.0" },
          { release_url: "https://example.com/owner/repo/releases/tag/v2" },
        ],
      },
      {
        versions: [
          { release_url: "https://github.com/other/tool/releases/tag/release/2026" },
        ],
      },
      { versions: null },
      {},
    ]);

    assert.equal(count, 2);
    assert.deepEqual(writes.map(({ key }) => key).sort(), [
      "github:release-generation:other/tool",
      "github:release-generation:owner/repo",
    ]);
    const generation = await getGitHubLatestReleaseGeneration(
      cache,
      "OWNER",
      "REPO",
    );
    assert.match(generation, /^[0-9a-f-]{36}$/);
  `);
});

test("invalid latest generations are ignored", () => {
  runGenerationTest(`
    import assert from "node:assert/strict";
    import { getGitHubLatestReleaseGeneration } from "./web/src/lib/github/release-generation.ts";

    const cache = { get: async () => "../../untrusted" };
    assert.equal(
      await getGitHubLatestReleaseGeneration(cache, "owner", "repo"),
      undefined,
    );
  `);
});

test("generation lookup failures fall back to legacy cache keys", () => {
  runGenerationTest(`
    import assert from "node:assert/strict";
    import { getGitHubLatestReleaseGeneration } from "./web/src/lib/github/release-generation.ts";

    const warnings = [];
    console.warn = (...args) => warnings.push(args);
    const cache = { get: async () => { throw new Error("KV unavailable"); } };
    assert.equal(
      await getGitHubLatestReleaseGeneration(cache, "owner", "repo"),
      undefined,
    );
    assert.equal(warnings.length, 1);
  `);
});
