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
  // Match aqua:, github:, or ubi: prefixes
  const match = backend.match(/^(aqua|github|ubi):([^/]+\/[^/\[\s]+)/);
  if (match) {
    // Remove any trailing [exe=...] or similar modifiers
    return match[2].replace(/\[.*$/, "");
  }
  return null;
}

// Fetch and parse mise registry.toml to get tool metadata
async function fetchMiseRegistry() {
  const registry = new Map();

  try {
    const response = await fetch(
      "https://raw.githubusercontent.com/jdx/mise/refs/heads/main/registry.toml"
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const content = await response.text();
    const parsed = parse(content);

    if (parsed.tools) {
      for (const [name, toolData] of Object.entries(parsed.tools)) {
        const entry = {
          github: null,
          description: toolData.description || null,
        };

        // Extract GitHub slug from backends
        const backends = toolData.backends || [];
        for (const backend of backends) {
          // Ensure backend is a string
          if (typeof backend !== "string") continue;
          const slug = extractGithubSlug(backend);
          if (slug) {
            entry.github = slug;
            break;
          }
        }

        // For tools like "cli/cli" that are already GitHub slugs
        if (!entry.github && name.includes("/")) {
          entry.github = name;
        }

        registry.set(name, entry);
      }
    }

    const withGithub = [...registry.values()].filter((e) => e.github).length;
    const withDesc = [...registry.values()].filter((e) => e.description).length;
    console.log(
      `Loaded ${registry.size} tools from mise registry (${withGithub} with GitHub, ${withDesc} with description)`
    );
  } catch (e) {
    console.warn(`Warning: Could not fetch mise registry: ${e.message}`);
  }

  return registry;
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

async function main() {
  console.log("Generating tools manifest...");

  // Load mise registry for GitHub URLs and descriptions
  const miseRegistry = await fetchMiseRegistry();

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

      // Add GitHub slug and description if available
      const registryEntry = miseRegistry.get(toolName);
      if (registryEntry) {
        if (registryEntry.github) {
          tool.github = registryEntry.github;
          withGithub++;
        }
        if (registryEntry.description) {
          tool.description = registryEntry.description;
          withDesc++;
        }
      }

      tools.push(tool);
    }
  }

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
