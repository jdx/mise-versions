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
import { fetchWithRetry } from "./lib/fetch-with-retry.js";

const DOCS_DIR = join(process.cwd(), "docs");
const MANUAL_OVERRIDES_FILE = join(DOCS_DIR, "manual-overrides.json");

// Prerelease version regex - ported from mise
const PRERELEASE_REGEX =
  /(-src|-dev|-latest|-stm|[-.](rc|pre)|-milestone|-alpha|-beta|-next|([abc])\d+$|snapshot|master)/i;

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

// Load backends, descriptions, and security info for every tool in a single
// mise call. `mise registry --json --security` returns one JSON array with
// every field we need (added in mise v2026.4.22 via jdx/mise#9364) —
// eliminates the per-tool `mise tool X --json` shell-outs the script
// previously did just to fetch each tool's `security` array.
//
// Falls back to plain `mise registry --json` (no `security`) if the local
// mise predates the flag, so the rest of the manifest still syncs.
function runMiseRegistry(args) {
  return execSync(`mise registry --json${args}`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function getRegistryInfo() {
  let output;
  try {
    output = runMiseRegistry(" --security");
  } catch (e) {
    // mise older than v2026.4.22 rejects `--security`. Fall back to the
    // plain registry — security data will be missing from this sync, but
    // the rest of the manifest (backends, descriptions) still flows.
    console.warn(
      `Warning: 'mise registry --json --security' failed (${e.message.split("\n")[0]}); ` +
        "falling back to 'mise registry --json' without security info. " +
        "Upgrade mise to v2026.4.22+ to include security metadata.",
    );
    try {
      output = runMiseRegistry("");
    } catch (fallbackErr) {
      console.error(
        `Warning: Failed to get mise registry: ${fallbackErr.message}`,
      );
      return new Map();
    }
  }

  try {
    const entries = JSON.parse(output);
    const infoMap = new Map();
    // First pass: index every `short`. The previous per-tool
    // `mise tool <name> --json` call resolved aliases automatically,
    // so we second-pass each entry's `aliases` to preserve that
    // behavior for any TOML file whose name is an alias rather than a
    // short. Shorts win over aliases (so an explicitly-named tool
    // never has its metadata clobbered by another tool that happens
    // to alias the same string).
    for (const entry of entries) {
      if (!entry.short) continue;
      infoMap.set(entry.short, {
        backends: entry.backends || [],
        description: entry.description || null,
        security: entry.security || [],
      });
    }
    for (const entry of entries) {
      if (!entry.short || !Array.isArray(entry.aliases)) continue;
      const info = infoMap.get(entry.short);
      if (!info) continue;
      for (const alias of entry.aliases) {
        if (!alias || infoMap.has(alias)) continue;
        infoMap.set(alias, info);
      }
    }
    return infoMap;
  } catch (e) {
    console.error(`Warning: Failed to parse mise registry: ${e.message}`);
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

  // Load backends + descriptions for every tool in one mise call.
  console.log("Loading registry info from mise...");
  const registryMap = getRegistryInfo();
  console.log(`Loaded registry info for ${registryMap.size} tools`);

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

      const registryInfo = registryMap.get(toolName) || {
        backends: [],
        description: null,
        security: [],
      };

      if (registryInfo.description) {
        tool.description = registryInfo.description;
        withDesc++;
      }

      if (registryInfo.security && registryInfo.security.length > 0) {
        tool.security = registryInfo.security;
      }

      // Backends always set (default empty). github/repo_url/package urls
      // derive from the backend list.
      const backends = registryInfo.backends;
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
      if (!tool.github && toolName.includes("/")) {
        tool.github = toolName;
        tool.repo_url = buildRepoUrl(toolName);
        withGithub++;
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
    const response = await fetchWithRetry(syncUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiSecret}`,
      },
      body: JSON.stringify({ tools }),
    });

    const result = await response.json();
    console.log("Sync completed successfully:");
    console.log(`  - Upserted: ${result.upserted}`);
    console.log(`  - Deleted: ${result.deleted}`);
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
      console.error(
        `Error: ${result.errors} tools (${(errorRate * 100).toFixed(1)}%) failed to sync`,
      );
      process.exit(1);
    } else if (result.errors > 0) {
      console.warn(
        `Warning: ${result.errors} tools failed to sync (${(errorRate * 100).toFixed(1)}%)`,
      );
    }
  } catch (e) {
    console.error("Sync failed:", e.message);
    process.exit(1);
  }
}

main();
