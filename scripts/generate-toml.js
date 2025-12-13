#!/usr/bin/env node
/**
 * Generate TOML version file with created_at timestamps.
 * Preserves version order from mise ls-remote.
 *
 * Usage: node generate-toml.js <tool> <json_data> [existing_toml_path]
 *
 * Input JSON format (NDJSON from `mise ls-remote --json`):
 *   {"version":"1.1.0"}
 *   {"version":"1.0.0","created_at":"2024-01-15T10:30:00Z"}
 *
 * Output TOML format (same order as input):
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

// Parse new version data (preserves order from mise ls-remote)
const newVersions = parseNdjson(jsonData);

// Escape strings for TOML output
function escapeTomlString(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Generate TOML, preserving input order from mise ls-remote
const tomlLines = ["[versions]"];
for (const v of newVersions) {
  // Use API timestamp, fall back to existing timestamp, then use current time
  const timestamp = v.created_at || existingVersions[v.version] || now;
  // Use TOML native datetime (no quotes) - must be valid ISO 8601
  tomlLines.push(`"${escapeTomlString(v.version)}" = { created_at = ${timestamp} }`);
}
console.log(tomlLines.join("\n"));
