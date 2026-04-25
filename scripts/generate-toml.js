#!/usr/bin/env node
/**
 * Generate TOML version file with created_at timestamps and release URLs.
 * Preserves version order from mise ls-remote.
 *
 * Usage: cat versions.ndjson | node generate-toml.js <tool> [existing_toml_path]
 *
 * Input JSON format (NDJSON from stdin):
 *   {"version":"1.1.0"}
 *   {"version":"1.0.0","created_at":"2024-01-15T10:30:00Z","release_url":"https://github.com/..."}
 *
 * Output TOML format (same order as input):
 *   [versions]
 *   "1.1.0" = { created_at = "2024-02-20T14:45:00Z" }
 *   "1.0.0" = { created_at = "2024-01-15T10:30:00Z", release_url = "https://github.com/..." }
 */

import { readFileSync, existsSync } from "fs";
import { parse, stringify } from "smol-toml";
import semver from "semver";

const [, , tool, existingTomlPath] = process.argv;

// Tools whose upstream version order is unstable across runs (e.g. backport
// patches on old majors interleaved by created_at) get force-sorted by semver
// to prevent endless no-op TOML reorderings.
const UNSTABLE_TOOLS_PATH = new URL("./unstable-tools.txt", import.meta.url)
  .pathname;
const UNSTABLE_TOOLS = existsSync(UNSTABLE_TOOLS_PATH)
  ? new Set(
      readFileSync(UNSTABLE_TOOLS_PATH, "utf-8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#")),
    )
  : new Set();

if (!tool) {
  console.error(
    "Usage: cat versions.ndjson | node generate-toml.js <tool> [existing_toml_path]",
  );
  process.exit(1);
}

// Read NDJSON from stdin
const stdinData = readFileSync(0, "utf-8");

// Parse NDJSON input (one JSON object per line), deduplicating versions
function parseNdjson(ndjsonData) {
  const versions = [];
  const seen = new Set();
  const lines = ndjsonData.trim().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.version && !seen.has(obj.version)) {
        seen.add(obj.version);
        versions.push({
          version: obj.version,
          created_at: obj.created_at || null,
          release_url: obj.release_url || null,
        });
      }
    } catch (e) {
      console.error(`Warning: Failed to parse line: ${line}`);
    }
  }
  return versions;
}

// Main logic
const now = new Date().toISOString();

// Placeholder timestamp used when no real timestamp is available
const PLACEHOLDER_TIMESTAMP = "2025-01-01T00:00:00.000Z";

// Convert Date object or string to ISO string, treating placeholders as null
function toISOString(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso === PLACEHOLDER_TIMESTAMP ? null : iso;
  }
  if (typeof value === "string") {
    return value === PLACEHOLDER_TIMESTAMP ? null : value;
  }
  return null;
}

// Load existing TOML if provided
let existingVersions = {};
if (existingTomlPath && existsSync(existingTomlPath)) {
  try {
    const existingContent = readFileSync(existingTomlPath, "utf-8");
    const parsed = parse(existingContent);
    if (parsed.versions) {
      for (const [version, data] of Object.entries(parsed.versions)) {
        existingVersions[version] = {
          created_at: toISOString(data.created_at),
          release_url: data.release_url || null,
        };
      }
    }
  } catch (e) {
    console.error(`Warning: Failed to read existing TOML: ${e.message}`);
  }
}

// Parse new version data (preserves order from mise ls-remote)
const newVersions = parseNdjson(stdinData);

// For "unstable" tools, sort by semver ascending so the output is
// deterministic regardless of which fetch path produced the input. Versions
// that don't parse as semver fall back to natural string compare.
if (UNSTABLE_TOOLS.has(tool)) {
  newVersions.sort((a, b) => {
    const av = semver.coerce(a.version);
    const bv = semver.coerce(b.version);
    if (av && bv) {
      const cmp = semver.compare(av, bv);
      if (cmp !== 0) return cmp;
    } else if (av) {
      return -1;
    } else if (bv) {
      return 1;
    }
    return a.version.localeCompare(b.version);
  });
}

// Build output with inline tables for compactness
const lines = ["[versions]"];
for (const v of newVersions) {
  const existing = existingVersions[v.version] || {};
  // Use API timestamp, fall back to existing timestamp, then use current time
  const timestamp = v.created_at || existing.created_at || now;
  const isoDate = new Date(timestamp).toISOString();
  // Use API release_url, fall back to existing release_url
  const releaseUrl = v.release_url || existing.release_url;

  // Output as inline table
  if (releaseUrl) {
    lines.push(
      `"${v.version}" = { created_at = ${isoDate}, release_url = "${releaseUrl}" }`,
    );
  } else {
    lines.push(`"${v.version}" = { created_at = ${isoDate} }`);
  }
}

console.log(lines.join("\n"));
