#!/usr/bin/env node
/**
 * One-off seed for a tool whose backend lists versions without created_at.
 *
 * Reads a `mise ls-remote --json` array on stdin, looks each version up as a
 * tag in a git repository and writes NDJSON with created_at set to the tagged
 * commit's date. Versions with no matching tag are left undated, so
 * generate-toml.js stamps them with its first-import seed date.
 *
 * Usage:
 *   mise ls-remote --minimum-release-age 0s --prerelease --json \
 *     --no-versions-host --strict-metadata aws-cli > aws-cli.json
 *   node scripts/seed-created-at-from-git-tags.js \
 *     https://github.com/aws/aws-cli.git < aws-cli.json |
 *     node scripts/generate-toml.js aws-cli > docs/aws-cli.toml
 *
 * Options: --tag-prefix=v  (strip a prefix from tag names before matching)
 *
 * Only for a tool's first import: once docs/<tool>.toml exists, generate-toml.js
 * preserves its dates.
 */

import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const args = process.argv.slice(2);
const repo = args.find((a) => !a.startsWith("--"));
const prefixArg = args.find((a) => a.startsWith("--tag-prefix="));
const tagPrefix = prefixArg ? prefixArg.slice("--tag-prefix=".length) : "";

if (!repo) {
  console.error(
    "Usage: node seed-created-at-from-git-tags.js <git-url> [--tag-prefix=v] < ls-remote.json",
  );
  process.exit(1);
}

const versions = JSON.parse(readFileSync(0, "utf-8"));

// Commit date of the tagged commit (the peeled commit for annotated tags).
const format =
  "%(refname:short)|%(if)%(*committerdate)%(then)%(*committerdate:iso-strict)%(else)%(committerdate:iso-strict)%(end)";

const dir = mkdtempSync(join(tmpdir(), "seed-tags-"));
const dates = new Map();
try {
  execFileSync(
    "git",
    ["clone", "-q", "--bare", "--filter=blob:none", repo, dir],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  const out = execFileSync(
    "git",
    ["-C", dir, "for-each-ref", "refs/tags", `--format=${format}`],
    { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 },
  );
  for (const line of out.split("\n")) {
    const i = line.lastIndexOf("|");
    if (i < 0 || i === line.length - 1) continue;
    const tag = line.slice(0, i);
    if (tagPrefix && !tag.startsWith(tagPrefix)) continue;
    const name = tag.slice(tagPrefix.length);
    const date = new Date(line.slice(i + 1)).toISOString();
    dates.set(name, date);
    // Some packagers drop leading zeros from numeric segments (vim's tag
    // v9.1.0990 is conda's 9.1.990); keep the exact spelling when both exist.
    const stripped = name.replace(/(^|\.)0+(?=\d)/g, "$1");
    if (!dates.has(stripped)) dates.set(stripped, date);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

let matched = 0;
for (const v of versions) {
  const created_at = v.created_at || dates.get(v.version);
  if (created_at && !v.created_at) matched++;
  console.log(JSON.stringify(created_at ? { ...v, created_at } : v));
}
console.error(`Dated ${matched} of ${versions.length} versions from tags`);
