import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizePackslip } from "./packslip-manifest";
const repo = "vendor/tool";
const statement = {
  predicateType: "https://packslip.dev/release/v1",
  predicate: {
    project: `github.com/${repo}`,
    version: "1.0",
    published_at: "2026-09-01",
    artifacts: [
      {
        os: "linux",
        arch: "x86_64",
        bin: ["tool"],
        provenance: ["https://example.com/attestation"],
      },
    ],
    resources: [{ kind: "cli-spec", format: "usage" }],
  },
};
const verified = {
  project: `github.com/${repo}`,
  version: "1.0",
  attested_by: "vendor",
  scheme: "sigstore-oidc",
  issuer: "https://token.actions.githubusercontent.com",
  key_id: `https://github.com/${repo}/.github/workflows/release.yml@refs/tags/v1.0`,
  logged_at: "2026-09-01",
};
const summarize = (s = statement, v = verified) =>
  summarizePackslip(
    s,
    v,
    repo,
    "https://github.com/vendor/tool/releases/download/v1.0/packslip.sigstore.json",
    "https://github.com/vendor/tool/releases/tag/v1.0",
  );
test("Usage spec enables generated completions without claiming bundled completions or skills", () => {
  const result = summarize();
  assert.deepEqual(
    result.capabilities.map((c) => c.label),
    ["Usage CLI spec"],
  );
  assert.equal(result.provenanceCount, 1);
  assert.deepEqual(result.platforms, ["Linux / x86_64"]);
});
test("resources promote declared capabilities, ignore unknown kinds, never execute commands", () => {
  const s = structuredClone(statement) as any;
  s.predicate.resources = [
    { kind: "completion", shells: ["bash", "zsh"], exec: ["do-not-run"] },
    { kind: "skill" },
    { kind: "sbom" },
    { kind: "future" },
  ];
  assert.deepEqual(
    summarize(s).capabilities.map((c) => c.label),
    ["Shell completions", "Agent skills", "Software bill of materials"],
  );
});
test("rejects wrong project, version, signer, unlogged and repackaged manifests", () => {
  for (const change of [
    { project: "github.com/other/tool" },
    { version: "2.0" },
    { key_id: "https://github.com/vendor/tool-evil/release" },
    { logged_at: "" },
    { attested_by: "repackager" },
    { issuer: "https://evil.example" },
  ]) {
    assert.throws(() => summarize(statement, { ...verified, ...change }));
  }
  const s = structuredClone(statement);
  s.predicate.project = "github.com/other/tool";
  assert.throws(() => summarize(s));
});

test("directory badges resolve supported backends without mistaking plugins for vendors", async () => {
  const { getPackslipForBackends } = await import("./packslip");
  assert.equal(
    getPackslipForBackends(["aqua:jdx/hk"])?.project,
    "github.com/jdx/hk",
  );
  assert.equal(
    getPackslipForBackends(["packslip:github.com/jdx/hk"])?.project,
    "github.com/jdx/hk",
  );
  assert.equal(getPackslipForBackends(["asdf:jdx/hk"]), undefined);
  assert.equal(getPackslipForBackends(["github:jdx/hk-other"]), undefined);
});
