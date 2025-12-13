#!/usr/bin/env node
/**
 * Generate tools.json manifest from all TOML version files.
 *
 * Usage: node generate-manifest.js
 *
 * Reads all .toml files in docs/ directory and generates docs/tools.json
 * with metadata about each tool for the front-end UI.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
import { join, basename } from "path";
import TOML from "@iarna/toml";

const DOCS_DIR = join(process.cwd(), "docs");
const OUTPUT_FILE = join(DOCS_DIR, "tools.json");

// Compare semantic versions (newest first)
function compareVersions(a, b) {
  const partsA = a.split(/[.-]/).map((p) => (isNaN(p) ? p : parseInt(p, 10)));
  const partsB = b.split(/[.-]/).map((p) => (isNaN(p) ? p : parseInt(p, 10)));

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const partA = partsA[i] ?? 0;
    const partB = partsB[i] ?? 0;

    if (typeof partA === "number" && typeof partB === "number") {
      if (partA !== partB) return partB - partA;
    } else {
      const strA = String(partA);
      const strB = String(partB);
      if (strA !== strB) return strB.localeCompare(strA);
    }
  }
  return 0;
}

function processTomlFile(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = TOML.parse(content);

    if (!parsed.versions || Object.keys(parsed.versions).length === 0) {
      return null;
    }

    const versions = Object.entries(parsed.versions);
    const sortedVersions = versions.sort((a, b) => compareVersions(a[0], b[0]));

    // Get latest version (first after sorting)
    const [latestVersion, latestData] = sortedVersions[0];

    // Find most recent created_at across all versions
    let lastUpdated = null;
    for (const [, data] of versions) {
      if (data.created_at) {
        if (!lastUpdated || data.created_at > lastUpdated) {
          lastUpdated = data.created_at;
        }
      }
    }

    return {
      latest_version: latestVersion,
      version_count: versions.length,
      last_updated: lastUpdated || latestData?.created_at || null,
    };
  } catch (e) {
    console.error(`Warning: Failed to process ${filePath}: ${e.message}`);
    return null;
  }
}

function main() {
  console.log("Generating tools manifest...");

  // Find all .toml files in docs/
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".toml"));
  console.log(`Found ${files.length} TOML files`);

  const tools = [];

  for (const file of files) {
    const toolName = basename(file, ".toml");
    const filePath = join(DOCS_DIR, file);
    const metadata = processTomlFile(filePath);

    if (metadata) {
      tools.push({
        name: toolName,
        ...metadata,
      });
    }
  }

  // Sort tools alphabetically
  tools.sort((a, b) => a.name.localeCompare(b.name));

  const manifest = {
    generated_at: new Date().toISOString(),
    tool_count: tools.length,
    tools,
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(manifest, null, 2));
  console.log(`Generated ${OUTPUT_FILE} with ${tools.length} tools`);
}

main();
