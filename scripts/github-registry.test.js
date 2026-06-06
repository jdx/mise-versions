import assert from "node:assert/strict";
import test from "node:test";
import { isRegisteredGitHubRepo } from "../web/src/lib/github/registry.ts";

function analyticsDbReturning(row, seen = {}) {
  return {
    prepare(query) {
      seen.query = query;
      return {
        bind(...args) {
          seen.args = args;
          return {
            first: async () => row,
          };
        },
      };
    },
  };
}

test("GitHub registry allowlist normalizes and checks registry-backed slugs", async () => {
  const seen = {};
  const allowed = await isRegisteredGitHubRepo(
    analyticsDbReturning({ allowed: 1 }, seen),
    "Cli",
    "CLI",
  );

  assert.equal(allowed, true);
  assert.match(seen.query, /FROM tools t/);
  assert.deepEqual(seen.args, [
    "cli/cli",
    "cli/cli",
    "aqua:cli/cli",
    "github:cli/cli",
    "ubi:cli/cli",
    "aqua:cli/cli[%",
    "github:cli/cli[%",
    "ubi:cli/cli[%",
  ]);
});

test("GitHub registry allowlist rejects unknown repos", async () => {
  const allowed = await isRegisteredGitHubRepo(
    analyticsDbReturning(null),
    "someone",
    "anything",
  );

  assert.equal(allowed, false);
});
