#!/usr/bin/env node
/**
 * Generate tools.json manifest from all TOML version files.
 *
 * Usage: node generate-manifest.js
 *
 * Reads all .toml files in docs/ directory and generates docs/tools.json
 * with metadata about each tool for the front-end UI.
 */

import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { parse } from "smol-toml";
import { execSync } from "child_process";

const DOCS_DIR = join(process.cwd(), "docs");
const OUTPUT_FILE = join(DOCS_DIR, "tools.json");

// Convert Date object or string to ISO string
function toISOString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

// Extract GitHub slug from backend string
// Supports: aqua:owner/repo, github:owner/repo, ubi:owner/repo
function extractGithubSlug(backend) {
  if (!backend) return null;
  // Match aqua:, github:, or ubi: prefixes
  const match = backend.match(/^(aqua|github|ubi):([^/]+\/[^/\[\s]+)/);
  if (match) {
    // Remove any trailing [exe=...] or similar modifiers
    return match[2].replace(/\[.*$/, "");
  }
  return null;
}

// Get tool info using mise tool --json command
// TODO: Use `mise registry --json` when available in a future mise release
// to get descriptions for all tools in a single call
function getToolInfo(toolName) {
  try {
    const output = execSync(`mise tool "${toolName}" --json`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const data = JSON.parse(output);

    let github = extractGithubSlug(data.backend);
    // For tools like "cli/cli" that are already GitHub slugs
    if (!github && toolName.includes("/")) {
      github = toolName;
    }

    return {
      github,
      description: data.description || null,
    };
  } catch {
    return { github: null, description: null };
  }
}

function processTomlFile(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = parse(content);

    if (!parsed.versions || Object.keys(parsed.versions).length === 0) {
      return null;
    }

    // Use order from mise ls-remote (preserved in TOML)
    // mise ls-remote returns oldest first, so last entry is latest
    const versions = Object.entries(parsed.versions);
    const [latestVersion, latestData] = versions[versions.length - 1];

    // Find most recent created_at across all versions
    let lastUpdated = null;
    for (const [, data] of versions) {
      const createdAt = toISOString(data.created_at);
      if (createdAt) {
        if (!lastUpdated || createdAt > lastUpdated) {
          lastUpdated = createdAt;
        }
      }
    }

    return {
      latest_version: latestVersion,
      version_count: versions.length,
      last_updated: lastUpdated || toISOString(latestData?.created_at) || null,
    };
  } catch (e) {
    console.error(`Warning: Failed to process ${filePath}: ${e.message}`);
    return null;
  }
}

function main() {
  console.log("Generating tools manifest...");

  // Find all .toml files in docs/, excluding internal tools
  const EXCLUDED_PREFIXES = ["python-precompiled"];
  const files = readdirSync(DOCS_DIR).filter((f) => {
    if (!f.endsWith(".toml")) return false;
    const toolName = basename(f, ".toml");
    return !EXCLUDED_PREFIXES.some((prefix) => toolName.startsWith(prefix));
  });
  console.log(`Found ${files.length} TOML files`);

  const tools = [];
  let withGithub = 0;
  let withDesc = 0;

  for (const file of files) {
    const toolName = basename(file, ".toml");
    const filePath = join(DOCS_DIR, file);
    const metadata = processTomlFile(filePath);

    if (metadata) {
      const tool = {
        name: toolName,
        ...metadata,
      };

      // Get GitHub slug and description from mise
      const info = getToolInfo(toolName);
      if (info.github) {
        tool.github = info.github;
        withGithub++;
      }
      if (info.description) {
        tool.description = info.description;
        withDesc++;
      }

      tools.push(tool);
    }

    // Progress indicator
    if (tools.length % 100 === 0) {
      process.stdout.write(`\rProcessed ${tools.length} tools...`);
    }
  }
  console.log(`\rProcessed ${tools.length} tools`);

  // Sort tools alphabetically
  tools.sort((a, b) => a.name.localeCompare(b.name));

  const manifest = {
    tool_count: tools.length,
    tools,
  };

  writeFileSync(OUTPUT_FILE, JSON.stringify(manifest, null, 2));
  console.log(
    `Generated ${OUTPUT_FILE} with ${tools.length} tools (${withGithub} with GitHub, ${withDesc} with description)`
  );
}

main();
