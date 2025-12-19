#!/usr/bin/env node
/**
 * Fetch tool metadata from package registries and GitHub, sync to D1.
 *
 * Usage: node fetch-metadata.js [--tool=name]
 *
 * Environment variables:
 *   SYNC_API_URL - Base URL of the API (e.g., https://mise-tools.jdx.dev)
 *   API_SECRET   - API secret for authentication
 *   TOKEN_MANAGER_URL / TOKEN_MANAGER_SECRET - GitHub token manager (optional)
 *   GITHUB_TOKEN - Fallback GitHub token (optional)
 *
 * Fetches license, homepage, authors, and description from:
 * - npm (registry.npmjs.org)
 * - crates.io (crates.io/api/v1)
 * - PyPI (pypi.org/pypi)
 * - RubyGems (rubygems.org/api/v1)
 * - GitHub (api.github.com)
 *
 * Syncs results directly to D1 via /api/admin/metadata/sync
 */

import { readdirSync } from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";

const DOCS_DIR = join(process.cwd(), "docs");

// Get all backends from mise registry
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

// Extract GitHub slug from backend string
function extractGithubSlug(backend) {
  if (!backend) return null;
  const match = backend.match(/^(aqua|github|ubi):([^/]+\/[^/\[\s]+)/);
  if (match) {
    return match[2].replace(/\[.*$/, "");
  }
  return null;
}

// Get all tools from TOML files
function getToolsFromToml() {
  const EXCLUDED_PREFIXES = ["python-precompiled"];
  const files = readdirSync(DOCS_DIR).filter((f) => {
    if (!f.endsWith(".toml")) return false;
    const toolName = basename(f, ".toml");
    return !EXCLUDED_PREFIXES.some((prefix) => toolName.startsWith(prefix));
  });

  const backendMap = getAllBackends();
  const tools = [];

  for (const file of files) {
    const toolName = basename(file, ".toml");
    const backends = backendMap.get(toolName) || [];

    // Extract github from backends
    let github = null;
    for (const backend of backends) {
      const slug = extractGithubSlug(backend);
      if (slug) {
        github = slug;
        break;
      }
    }

    tools.push({
      name: toolName,
      backends,
      github,
    });
  }

  return tools;
}

// Token manager state
let currentToken = null;
let currentTokenId = null;

// Get a token from the token manager
async function getTokenFromManager() {
  const baseUrl = process.env.TOKEN_MANAGER_URL;
  const secret = process.env.TOKEN_MANAGER_SECRET;

  if (!baseUrl || !secret) {
    return null;
  }

  try {
    const response = await fetch(`${baseUrl}/api/token`, {
      headers: {
        Authorization: `Bearer ${secret}`,
      },
    });

    if (!response.ok) {
      console.error(`Failed to get token from manager: ${response.status}`);
      return null;
    }

    const data = await response.json();
    currentToken = data.token;
    currentTokenId = data.token_id || data.installation_id;
    console.log(`Got token from manager (ID: ${currentTokenId})`);
    return currentToken;
  } catch (e) {
    console.error(`Error getting token from manager: ${e.message}`);
    return null;
  }
}

// Mark current token as rate-limited and get a new one
async function rotateToken() {
  const baseUrl = process.env.TOKEN_MANAGER_URL;
  const secret = process.env.TOKEN_MANAGER_SECRET;

  if (!baseUrl || !secret || !currentTokenId) {
    return null;
  }

  try {
    // Mark current token as rate-limited
    const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
    await fetch(`${baseUrl}/api/token/rate-limit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        token_id: currentTokenId,
        reset_at: resetAt,
      }),
    });
    console.log(`Marked token ${currentTokenId} as rate-limited`);

    // Get a new token
    return await getTokenFromManager();
  } catch (e) {
    console.error(`Error rotating token: ${e.message}`);
    return null;
  }
}

// Get the current GitHub token (from manager or env)
async function getGitHubToken() {
  // Try token manager first
  if (!currentToken) {
    const managerToken = await getTokenFromManager();
    if (managerToken) return managerToken;
  } else {
    return currentToken;
  }

  // Fall back to env var
  return process.env.GITHUB_TOKEN || null;
}

// Rate limiters for each API
class RateLimiter {
  constructor(requestsPerSecond) {
    this.minInterval = 1000 / requestsPerSecond;
    this.lastRequest = 0;
  }

  async wait() {
    const elapsed = Date.now() - this.lastRequest;
    if (elapsed < this.minInterval) {
      await new Promise((r) => setTimeout(r, this.minInterval - elapsed));
    }
    this.lastRequest = Date.now();
  }
}

const rateLimiters = {
  npm: new RateLimiter(50), // 50 req/sec (conservative)
  crates: new RateLimiter(1), // 1 req/sec (required by crates.io)
  pypi: new RateLimiter(5), // 5 req/sec (conservative)
  rubygems: new RateLimiter(5), // 5 req/sec (conservative)
  github: new RateLimiter(10), // 10 req/sec (with token)
};

// Fetch with timeout and retry
async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.status === 429) {
        // Rate limited, wait and retry
        const retryAfter = response.headers.get("retry-after") || 60;
        console.log(`Rate limited, waiting ${retryAfter}s...`);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (response.status === 404) {
        return null; // Package not found
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

// Extract package name from backend string
function extractPackageName(backend, prefix) {
  if (!backend.startsWith(prefix + ":")) return null;
  // Remove prefix and any [options]
  return backend.slice(prefix.length + 1).replace(/\[.*$/, "");
}

// Fetch npm metadata
async function fetchNpmMetadata(packageName) {
  await rateLimiters.npm.wait();
  try {
    const data = await fetchWithRetry(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}`
    );
    if (!data) return null;

    const latest = data["dist-tags"]?.latest;
    const latestData = latest ? data.versions?.[latest] : null;

    const authors = [];
    if (latestData?.author?.name) {
      authors.push(latestData.author.name);
    }
    if (latestData?.maintainers) {
      for (const m of latestData.maintainers) {
        if (m.name && !authors.includes(m.name)) {
          authors.push(m.name);
        }
      }
    }

    return {
      license: latestData?.license || data.license || null,
      homepage: latestData?.homepage || data.homepage || null,
      description: latestData?.description || data.description || null,
      authors: authors.length > 0 ? authors.slice(0, 5) : null,
    };
  } catch (e) {
    console.error(`npm fetch failed for ${packageName}: ${e.message}`);
    return null;
  }
}

// Fetch crates.io metadata
async function fetchCargoMetadata(crateName) {
  await rateLimiters.crates.wait();
  try {
    const data = await fetchWithRetry(
      `https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}`,
      {
        headers: {
          "User-Agent": "mise-versions (https://github.com/jdx/mise-versions)",
        },
      }
    );
    if (!data?.crate) return null;

    return {
      license: data.crate.license || null,
      homepage: data.crate.homepage || null,
      description: data.crate.description || null,
      authors: null, // crates.io doesn't expose authors in this endpoint
    };
  } catch (e) {
    console.error(`crates.io fetch failed for ${crateName}: ${e.message}`);
    return null;
  }
}

// Fetch PyPI metadata
async function fetchPyPIMetadata(packageName) {
  await rateLimiters.pypi.wait();
  try {
    const data = await fetchWithRetry(
      `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`
    );
    if (!data?.info) return null;

    const authors = [];
    if (data.info.author) {
      authors.push(data.info.author);
    }
    if (data.info.maintainer && data.info.maintainer !== data.info.author) {
      authors.push(data.info.maintainer);
    }

    return {
      license: data.info.license || null,
      homepage:
        data.info.home_page || data.info.project_urls?.Homepage || null,
      description: data.info.summary || null,
      authors: authors.length > 0 ? authors : null,
    };
  } catch (e) {
    console.error(`PyPI fetch failed for ${packageName}: ${e.message}`);
    return null;
  }
}

// Fetch RubyGems metadata
async function fetchRubyGemsMetadata(gemName) {
  await rateLimiters.rubygems.wait();
  try {
    const data = await fetchWithRetry(
      `https://rubygems.org/api/v1/gems/${encodeURIComponent(gemName)}.json`
    );
    if (!data) return null;

    // RubyGems returns authors as a comma-separated string
    const authors = data.authors
      ? data.authors.split(",").map((a) => a.trim())
      : null;

    return {
      license: data.licenses?.[0] || null,
      homepage: data.homepage_uri || null,
      description: data.info || null,
      authors: authors?.slice(0, 5) || null,
    };
  } catch (e) {
    console.error(`RubyGems fetch failed for ${gemName}: ${e.message}`);
    return null;
  }
}

// Fetch GitHub metadata with token rotation support
async function fetchGitHubMetadata(owner, repo) {
  await rateLimiters.github.wait();

  const token = await getGitHubToken();

  try {
    const headers = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "mise-versions",
    };
    if (token) {
      headers.Authorization = `token ${token}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers, signal: controller.signal }
    );
    clearTimeout(timeout);

    // Handle rate limiting
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining === "0") {
        console.log(`GitHub rate limited, rotating token...`);
        const newToken = await rotateToken();
        if (newToken) {
          // Retry with new token
          return fetchGitHubMetadata(owner, repo);
        }
      }
      return null;
    }

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    return {
      license: data.license?.spdx_id || null,
      homepage: data.homepage || null,
      description: data.description || null,
      authors: null, // GitHub repos don't have author info directly
    };
  } catch (e) {
    console.error(`GitHub fetch failed for ${owner}/${repo}: ${e.message}`);
    return null;
  }
}

// Merge metadata from multiple sources with priority
function mergeMetadata(sources) {
  const result = {
    license: null,
    homepage: null,
    description: null,
    authors: null,
  };

  // Priority order for each field
  // description: GitHub > package manager (GitHub often has better descriptions)
  // license: GitHub > package manager (SPDX format)
  // homepage: GitHub > package manager
  // authors: package manager (most accurate)

  for (const source of sources) {
    if (!source) continue;

    // License: prefer first non-null (GitHub comes first typically)
    if (!result.license && source.license) {
      // Filter out common "not a license" values
      const skip = ["UNKNOWN", "NOASSERTION", ""];
      if (!skip.includes(source.license.toUpperCase())) {
        result.license = source.license;
      }
    }

    // Homepage: prefer first non-null
    if (!result.homepage && source.homepage) {
      result.homepage = source.homepage;
    }

    // Description: prefer first non-null
    if (!result.description && source.description) {
      result.description = source.description;
    }

    // Authors: prefer first non-null (usually package manager)
    if (!result.authors && source.authors) {
      result.authors = source.authors;
    }
  }

  return result;
}

// Parse command line arguments
function parseArgs() {
  const args = {
    tool: null,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--tool=")) {
      args.tool = arg.slice(7);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs();

  const syncApiUrl = process.env.SYNC_API_URL;
  const apiSecret = process.env.API_SECRET;

  if (!syncApiUrl) {
    console.error("Error: SYNC_API_URL environment variable is required");
    process.exit(1);
  }

  if (!apiSecret) {
    console.error("Error: API_SECRET environment variable is required");
    process.exit(1);
  }

  // Get tools from TOML files and mise registry
  console.log("Loading tools from TOML files...");
  const tools = getToolsFromToml();
  console.log(`Found ${tools.length} tools`);

  // Initialize GitHub token
  const tokenManagerUrl = process.env.TOKEN_MANAGER_URL;
  if (tokenManagerUrl) {
    console.log("Using token manager for GitHub API");
  } else if (process.env.GITHUB_TOKEN) {
    console.log("Using GITHUB_TOKEN from environment");
  } else {
    console.log("No GitHub token configured, API may be rate limited");
  }

  // Filter tools if specific tool requested
  let toolsToProcess = tools;
  if (args.tool) {
    toolsToProcess = toolsToProcess.filter((t) => t.name === args.tool);
    if (toolsToProcess.length === 0) {
      console.error(`Tool "${args.tool}" not found`);
      process.exit(1);
    }
  }

  console.log(`Processing ${toolsToProcess.length} tools...`);

  let processed = 0;
  const metadataEntries = [];

  for (const tool of toolsToProcess) {
    processed++;
    if (processed % 10 === 0) {
      process.stdout.write(`\rProcessing ${processed}/${toolsToProcess.length}...`);
    }

    const sources = [];

    // Fetch from GitHub if we have a slug
    if (tool.github) {
      const [owner, repo] = tool.github.split("/");
      if (owner && repo) {
        const ghMeta = await fetchGitHubMetadata(owner, repo);
        if (ghMeta) sources.push(ghMeta);
      }
    }

    // Fetch from package managers based on backends
    if (tool.backends) {
      for (const backend of tool.backends) {
        const npmPkg = extractPackageName(backend, "npm");
        if (npmPkg) {
          const npmMeta = await fetchNpmMetadata(npmPkg);
          if (npmMeta) sources.push(npmMeta);
          break;
        }

        const crate = extractPackageName(backend, "cargo");
        if (crate) {
          const cargoMeta = await fetchCargoMetadata(crate);
          if (cargoMeta) sources.push(cargoMeta);
          break;
        }

        const pypiPkg = extractPackageName(backend, "pipx");
        if (pypiPkg) {
          const pypiMeta = await fetchPyPIMetadata(pypiPkg);
          if (pypiMeta) sources.push(pypiMeta);
          break;
        }

        const gem = extractPackageName(backend, "gem");
        if (gem) {
          const gemMeta = await fetchRubyGemsMetadata(gem);
          if (gemMeta) sources.push(gemMeta);
          break;
        }
      }
    }

    // Merge metadata from all sources
    const metadata = mergeMetadata(sources);

    // Only include if we got useful data
    if (metadata.license || metadata.homepage || metadata.authors || metadata.description) {
      metadataEntries.push({
        name: tool.name,
        ...metadata,
      });
    }
  }

  console.log(`\rProcessed ${processed} tools, found metadata for ${metadataEntries.length}`);

  // Sync to D1 via API
  const syncUrl = `${syncApiUrl}/api/admin/metadata/sync`;
  console.log(`Syncing ${metadataEntries.length} entries to ${syncUrl}...`);

  try {
    const response = await fetch(syncUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiSecret}`,
      },
      body: JSON.stringify({ metadata: metadataEntries }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`Sync failed: ${response.status} ${response.statusText}`);
      console.error(text);
      process.exit(1);
    }

    const result = await response.json();
    console.log("Sync completed successfully:");
    console.log(`  - Updated: ${result.updated}`);
    console.log(`  - Errors: ${result.errors}`);
    console.log(`  - Total: ${result.total}`);

    if (result.failed_tools && result.failed_tools.length > 0) {
      console.log("\nFailed tools:");
      for (const ft of result.failed_tools) {
        console.log(`  - ${ft.name}: ${ft.error}`);
      }
    }
  } catch (e) {
    console.error("Sync failed:", e.message);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
