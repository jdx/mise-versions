#!/usr/bin/env node
/**
 * Generate TOML version file with created_at timestamps.
 *
 * Usage: node generate-toml.js <tool> <json_data> [existing_toml_path]
 *
 * Input JSON format (NDJSON from `mise ls-remote --json`):
 *   {"version":"1.0.0","created_at":"2024-01-15T10:30:00Z"}
 *   {"version":"1.1.0"}
 *
 * Output TOML format:
 *   [versions]
 *   "1.1.0" = { created_at = "2024-02-20T14:45:00Z" }
 *   "1.0.0" = { created_at = "2024-01-15T10:30:00Z" }
 */

import { readFileSync, existsSync } from "fs";
import TOML from "@iarna/toml";

const [, , tool, jsonData, existingTomlPath] = process.argv;

if (!tool || !jsonData) {
  console.error("Usage: node generate-toml.js <tool> <json_data> [existing_toml_path]");
  process.exit(1);
}

// Parse NDJSON input (one JSON object per line)
function parseNdjson(ndjsonData) {
  const versions = [];
  const lines = ndjsonData.trim().split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.version) {
        versions.push({
          version: obj.version,
          created_at: obj.created_at || null,
        });
      }
    } catch (e) {
      console.error(`Warning: Failed to parse line: ${line}`);
    }
  }
  return versions;
}

// Compare semantic versions (basic implementation)
function compareVersions(a, b) {
  const partsA = a.split(/[.-]/).map((p) => (isNaN(p) ? p : parseInt(p, 10)));
  const partsB = b.split(/[.-]/).map((p) => (isNaN(p) ? p : parseInt(p, 10)));

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const partA = partsA[i] ?? 0;
    const partB = partsB[i] ?? 0;

    if (typeof partA === "number" && typeof partB === "number") {
      if (partA !== partB) return partB - partA; // Descending order
    } else {
      const strA = String(partA);
      const strB = String(partB);
      if (strA !== strB) return strB.localeCompare(strA);
    }
  }
  return 0;
}

// Main logic
const now = new Date().toISOString();

// Load existing TOML if provided
let existingVersions = {};
if (existingTomlPath && existsSync(existingTomlPath)) {
  try {
    const existingContent = readFileSync(existingTomlPath, "utf-8");
    const parsed = TOML.parse(existingContent);
    if (parsed.versions) {
      for (const [version, data] of Object.entries(parsed.versions)) {
        existingVersions[version] = data.created_at;
      }
    }
  } catch (e) {
    console.error(`Warning: Failed to read existing TOML: ${e.message}`);
  }
}

// Parse new version data
const newVersions = parseNdjson(jsonData);

// Merge: use API timestamp, fall back to existing timestamp, then use current time
const mergedVersions = {};
for (const v of newVersions) {
  const timestamp = v.created_at || existingVersions[v.version] || now;
  mergedVersions[v.version] = timestamp;
}

// Sort versions (newest first) and build output object
const sortedVersions = Object.entries(mergedVersions).sort((a, b) =>
  compareVersions(a[0], b[0])
);

const output = {
  versions: Object.fromEntries(
    sortedVersions.map(([version, created_at]) => [version, { created_at }])
  ),
};

// Output TOML
console.log(TOML.stringify(output).trim());
