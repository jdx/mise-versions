#!/usr/bin/env node
/**
 * Sync tool metadata to D1 database via API.
 *
 * This script reads TOML files directly and calls mise commands to gather
 * metadata, then syncs everything to D1 in one step.
 *
 * Usage: node sync-to-d1.js
 *
 * Environment variables:
 *   SYNC_API_URL - Base URL of the API (e.g., https://mise-tools.jdx.dev)
 *   API_SECRET   - API secret for authentication
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { parse } from "smol-toml";
import { execSync } from "child_process";

const DOCS_DIR = join(process.cwd(), "docs");
const MANUAL_OVERRIDES_FILE = join(DOCS_DIR, "manual-overrides.json");

// Prerelease version regex - ported from mise
const PRERELEASE_REGEX = /(-src|-dev|-latest|-stm|[-.](rc|pre)|-milestone|-alpha|-beta|-next|([abc])\d+$|snapshot|master)/i;

function isPrerelease(version) {
  return PRERELEASE_REGEX.test(version);
}

function toISOString(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

function extractGithubSlug(backend) {
  if (!backend) return null;
  const match = backend.match(/^(aqua|github|ubi):([^/]+\/[^/\[\s]+)/);
  if (match) {
    return match[2].replace(/\[.*$/, "");
  }
  return null;
}

function getAllBackends() {
  try {
    const output = execSync("mise registry", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });

    const backendMap = new Map();
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      const toolName = parts[0];
      const backends = parts.slice(1);
      if (toolName && backends.length > 0) {
        backendMap.set(toolName, backends);
      }
    }
    return backendMap;
  } catch (e) {
    console.error(`Warning: Failed to get mise registry: ${e.message}`);
    return new Map();
  }
}

function buildPackageUrls(backends) {
  if (!backends || backends.length === 0) return null;

  const urls = {};
  for (const backend of backends) {
    if (backend.startsWith("npm:")) {
      const pkg = backend.slice(4).replace(/\[.*$/, "");
      urls.npm = `https://www.npmjs.com/package/${pkg}`;
    } else if (backend.startsWith("cargo:")) {
      const crate = backend.slice(6).replace(/\[.*$/, "");
      urls.cargo = `https://crates.io/crates/${crate}`;
    } else if (backend.startsWith("pipx:")) {
      const pkg = backend.slice(5).replace(/\[.*$/, "");
      urls.pypi = `https://pypi.org/project/${pkg}`;
    } else if (backend.startsWith("gem:")) {
      const gem = backend.slice(4).replace(/\[.*$/, "");
      urls.rubygems = `https://rubygems.org/gems/${gem}`;
    } else if (backend.startsWith("go:")) {
      const mod = backend.slice(3).replace(/\[.*$/, "");
      urls.go = `https://pkg.go.dev/${mod}`;
    }
  }

  return Object.keys(urls).length > 0 ? urls : null;
}

function buildAquaLink(backends) {
  if (!backends) return null;

  for (const backend of backends) {
    if (backend.startsWith("aqua:")) {
      const match = backend.match(/^aqua:([^/]+)\/([^/\[\s]+)/);
      if (match) {
        const [, owner, repo] = match;
        return `https://github.com/aquaproj/aqua-registry/blob/main/pkgs/${owner}/${repo}/registry.yaml`;
      }
    }
  }
  return null;
}

function buildRepoUrl(github) {
  if (!github) return null;
  return `https://github.com/${github}`;
}

function loadManualOverrides() {
  try {
    if (existsSync(MANUAL_OVERRIDES_FILE)) {
      const content = readFileSync(MANUAL_OVERRIDES_FILE, "utf-8");
      return JSON.parse(content);
    }
  } catch (e) {
    console.error(`Warning: Failed to load manual overrides: ${e.message}`);
  }
  return {};
}

function getToolInfo(toolName) {
  try {
    const output = execSync(`mise tool "${toolName}" --json`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const data = JSON.parse(output);

    let github = extractGithubSlug(data.backend);
    if (!github && toolName.includes("/")) {
      github = toolName;
    }

    return {
      github,
      description: data.description || null,
      security: data.security || [],
    };
  } catch {
    return { github: null, description: null, security: [] };
  }
}

function processTomlFile(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = parse(content);

    if (!parsed.versions || Object.keys(parsed.versions).length === 0) {
      return null;
    }

    const versions = Object.entries(parsed.versions);
    const [latestVersion, latestData] = versions[versions.length - 1];

    let latestStableVersion = null;
    for (let i = versions.length - 1; i >= 0; i--) {
      const [version] = versions[i];
      if (!isPrerelease(version)) {
        latestStableVersion = version;
        break;
      }
    }

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
      latest_stable_version: latestStableVersion || latestVersion,
      version_count: versions.length,
      last_updated: lastUpdated || toISOString(latestData?.created_at) || null,
    };
  } catch (e) {
    console.error(`Warning: Failed to process ${filePath}: ${e.message}`);
    return null;
  }
}

async function main() {
  const apiUrl = process.env.SYNC_API_URL;
  const apiSecret = process.env.API_SECRET;

  if (!apiUrl) {
    console.error("Error: SYNC_API_URL environment variable is required");
    process.exit(1);
  }

  if (!apiSecret) {
    console.error("Error: API_SECRET environment variable is required");
    process.exit(1);
  }

  console.log("Building tool manifest from TOML files...");

  // Load all backends from mise registry upfront
  console.log("Loading backends from mise registry...");
  const backendMap = getAllBackends();
  console.log(`Loaded backends for ${backendMap.size} tools`);

  // Load manual overrides
  const manualOverrides = loadManualOverrides();
  const overridesSize = Object.keys(manualOverrides).length;
  if (overridesSize > 0) {
    console.log(`Loaded manual overrides for ${overridesSize} tools`);
  }

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
  let withBackends = 0;
  let withPackageUrls = 0;

  for (const file of files) {
    const toolName = basename(file, ".toml");
    const filePath = join(DOCS_DIR, file);
    const metadata = processTomlFile(filePath);

    if (metadata) {
      const tool = {
        name: toolName,
        ...metadata,
      };

      // Get GitHub slug, description, and security from mise
      const info = getToolInfo(toolName);
      if (info.github) {
        tool.github = info.github;
        tool.repo_url = buildRepoUrl(info.github);
        withGithub++;
      }
      if (info.description) {
        tool.description = info.description;
        withDesc++;
      }
      if (info.security && info.security.length > 0) {
        tool.security = info.security;
      }

      // Get backends from registry (always set, default to empty array)
      const backends = backendMap.get(toolName) || [];
      tool.backends = backends;
      if (backends.length > 0) {
        withBackends++;

        const packageUrls = buildPackageUrls(backends);
        if (packageUrls) {
          tool.package_urls = packageUrls;
          withPackageUrls++;
        }

        const aquaLink = buildAquaLink(backends);
        if (aquaLink) {
          tool.aqua_link = aquaLink;
        }

        if (!tool.github) {
          for (const backend of backends) {
            const slug = extractGithubSlug(backend);
            if (slug) {
              tool.github = slug;
              tool.repo_url = buildRepoUrl(slug);
              withGithub++;
              break;
            }
          }
        }
      }

      // Apply manual overrides (highest priority)
      const overrides = manualOverrides[toolName];
      if (overrides) {
        if (overrides.github) {
          tool.github = overrides.github;
          tool.repo_url = buildRepoUrl(overrides.github);
          if (!tool.github) withGithub++;
        }
        if (overrides.description) {
          if (!tool.description) withDesc++;
          tool.description = overrides.description;
        }
        if (overrides.homepage) {
          tool.homepage = overrides.homepage;
        }
        if (overrides.license) {
          tool.license = overrides.license;
        }
      }

      tools.push(tool);
    }

    if (tools.length % 100 === 0) {
      process.stdout.write(`\rProcessed ${tools.length} tools...`);
    }
  }
  console.log(`\rProcessed ${tools.length} tools`);

  // Sort tools alphabetically
  tools.sort((a, b) => a.name.localeCompare(b.name));

  console.log(`Built manifest with ${tools.length} tools:`);
  console.log(`  - ${withGithub} with GitHub`);
  console.log(`  - ${withDesc} with description`);
  console.log(`  - ${withBackends} with backends`);
  console.log(`  - ${withPackageUrls} with package URLs`);

  // POST to sync endpoint
  const syncUrl = `${apiUrl}/api/admin/tools/sync`;
  console.log(`Syncing to ${syncUrl}...`);

  try {
    const response = await fetch(syncUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiSecret}`,
      },
      body: JSON.stringify({ tools }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`Sync failed: ${response.status} ${response.statusText}`);
      console.error(text);
      process.exit(1);
    }

    const result = await response.json();
    console.log("Sync completed successfully:");
    console.log(`  - Upserted: ${result.upserted}`);
    console.log(`  - Errors: ${result.errors}`);
    console.log(`  - Total: ${result.total}`);

    if (result.failed_tools && result.failed_tools.length > 0) {
      console.log("\nFailed tools:");
      for (const ft of result.failed_tools) {
        console.log(`  - ${ft.name}: ${ft.error}`);
      }
    }

    const errorRate = result.errors / result.total;
    if (errorRate > 0.1) {
      console.error(`Error: ${result.errors} tools (${(errorRate * 100).toFixed(1)}%) failed to sync`);
      process.exit(1);
    } else if (result.errors > 0) {
      console.warn(`Warning: ${result.errors} tools failed to sync (${(errorRate * 100).toFixed(1)}%)`);
    }
  } catch (e) {
    console.error("Sync failed:", e.message);
    process.exit(1);
  }
}

main();
