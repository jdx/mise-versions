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
import { parse } from "smol-toml";
import { execSync } from "child_process";

const DOCS_DIR = join(process.cwd(), "docs");
const OUTPUT_FILE = join(DOCS_DIR, "tools.json");
const METADATA_CACHE_FILE = join(DOCS_DIR, "metadata-cache.json");
const MANUAL_OVERRIDES_FILE = join(DOCS_DIR, "manual-overrides.json");

// Prerelease version regex - ported from mise
// Matches: -src, -dev, -rc, .rc, -alpha, -beta, -pre, .pre, -next, -milestone, snapshot, master, a1/b2/c3
const PRERELEASE_REGEX = /(-src|-dev|-latest|-stm|[-.](rc|pre)|-milestone|-alpha|-beta|-next|([abc])\d+$|snapshot|master)/i;

function isPrerelease(version) {
  return PRERELEASE_REGEX.test(version);
}

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

// Get all backends from mise registry
// Returns a Map of tool name -> array of backends
function getAllBackends() {
  try {
    const output = execSync("mise registry", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    });

    const backendMap = new Map();
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      // Format: "tool-name  backend1 backend2 backend3"
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

// Build package URLs from backends array
function buildPackageUrls(backends) {
  if (!backends || backends.length === 0) return null;

  const urls = {};
  for (const backend of backends) {
    // npm:package or npm:@scope/package
    if (backend.startsWith("npm:")) {
      const pkg = backend.slice(4).replace(/\[.*$/, "");
      urls.npm = `https://www.npmjs.com/package/${pkg}`;
    }
    // cargo:crate-name
    else if (backend.startsWith("cargo:")) {
      const crate = backend.slice(6).replace(/\[.*$/, "");
      urls.cargo = `https://crates.io/crates/${crate}`;
    }
    // pipx:package or pipx:package[extras]
    else if (backend.startsWith("pipx:")) {
      const pkg = backend.slice(5).replace(/\[.*$/, "");
      urls.pypi = `https://pypi.org/project/${pkg}`;
    }
    // gem:gem-name
    else if (backend.startsWith("gem:")) {
      const gem = backend.slice(4).replace(/\[.*$/, "");
      urls.rubygems = `https://rubygems.org/gems/${gem}`;
    }
    // go:module/path
    else if (backend.startsWith("go:")) {
      const mod = backend.slice(3).replace(/\[.*$/, "");
      urls.go = `https://pkg.go.dev/${mod}`;
    }
  }

  return Object.keys(urls).length > 0 ? urls : null;
}

// Build aqua registry link from backend
function buildAquaLink(backends) {
  if (!backends) return null;

  for (const backend of backends) {
    if (backend.startsWith("aqua:")) {
      // aqua:owner/repo or aqua:owner/repo[exe=...]
      const match = backend.match(/^aqua:([^/]+)\/([^/\[\s]+)/);
      if (match) {
        const [, owner, repo] = match;
        return `https://github.com/aquaproj/aqua-registry/blob/main/pkgs/${owner}/${repo}/registry.yaml`;
      }
    }
  }
  return null;
}

// Build repo URL from github slug
function buildRepoUrl(github) {
  if (!github) return null;
  return `https://github.com/${github}`;
}

// Load metadata cache if it exists
function loadMetadataCache() {
  try {
    if (existsSync(METADATA_CACHE_FILE)) {
      const content = readFileSync(METADATA_CACHE_FILE, "utf-8");
      return JSON.parse(content);
    }
  } catch (e) {
    console.error(`Warning: Failed to load metadata cache: ${e.message}`);
  }
  return {};
}

// Load manual overrides for core tools and others that need custom metadata
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

    // Use order from mise ls-remote (preserved in TOML)
    // mise ls-remote returns oldest first, so last entry is latest
    const versions = Object.entries(parsed.versions);
    const [latestVersion, latestData] = versions[versions.length - 1];

    // Find latest stable version (newest non-prerelease)
    let latestStableVersion = null;
    for (let i = versions.length - 1; i >= 0; i--) {
      const [version] = versions[i];
      if (!isPrerelease(version)) {
        latestStableVersion = version;
        break;
      }
    }

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
      latest_stable_version: latestStableVersion || latestVersion,
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

  // Load all backends from mise registry upfront
  console.log("Loading backends from mise registry...");
  const backendMap = getAllBackends();
  console.log(`Loaded backends for ${backendMap.size} tools`);

  // Load metadata cache
  const metadataCache = loadMetadataCache();
  const cacheSize = Object.keys(metadataCache).length;
  if (cacheSize > 0) {
    console.log(`Loaded metadata cache with ${cacheSize} entries`);
  }

  // Load manual overrides (for core tools etc.)
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
  let withLicense = 0;

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

      // Get backends from registry
      const backends = backendMap.get(toolName);
      if (backends && backends.length > 0) {
        tool.backends = backends;
        withBackends++;

        // Build package URLs from backends
        const packageUrls = buildPackageUrls(backends);
        if (packageUrls) {
          tool.package_urls = packageUrls;
          withPackageUrls++;
        }

        // Build aqua link if applicable
        const aquaLink = buildAquaLink(backends);
        if (aquaLink) {
          tool.aqua_link = aquaLink;
        }

        // Extract github from backends if not already set
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

      // Merge cached metadata (license, homepage, authors)
      const cached = metadataCache[toolName];
      if (cached) {
        if (cached.license) {
          tool.license = cached.license;
          withLicense++;
        }
        if (cached.homepage) {
          tool.homepage = cached.homepage;
        }
        if (cached.authors && cached.authors.length > 0) {
          tool.authors = cached.authors;
        }
        // Use cached description only if not already set
        if (!tool.description && cached.description) {
          tool.description = cached.description;
          withDesc++;
        }
      }

      // Apply manual overrides (highest priority - for core tools etc.)
      const overrides = manualOverrides[toolName];
      if (overrides) {
        if (overrides.github) {
          tool.github = overrides.github;
          tool.repo_url = buildRepoUrl(overrides.github);
          if (!tool.github) withGithub++; // Only increment if not already counted
        }
        if (overrides.description) {
          if (!tool.description) withDesc++; // Only increment if not already counted
          tool.description = overrides.description;
        }
        if (overrides.homepage) {
          tool.homepage = overrides.homepage;
        }
        if (overrides.license) {
          if (!tool.license) withLicense++;
          tool.license = overrides.license;
        }
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
    `Generated ${OUTPUT_FILE} with ${tools.length} tools:`
  );
  console.log(`  - ${withGithub} with GitHub`);
  console.log(`  - ${withDesc} with description`);
  console.log(`  - ${withBackends} with backends`);
  console.log(`  - ${withPackageUrls} with package URLs`);
  console.log(`  - ${withLicense} with license`);
}

main();
