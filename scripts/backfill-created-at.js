#!/usr/bin/env node
/**
 * Backfill created_at timestamps for existing TOML files.
 *
 * Usage: node backfill-created-at.js [--tool=name] [--dry-run]
 *
 * Fetches real release timestamps from GitHub via `mise ls-remote --json`
 * and updates TOML files that have placeholder timestamps.
 *
 * Environment variables:
 *   GITHUB_TOKEN - GitHub token for API access
 *   TOKEN_MANAGER_URL - URL of token manager service
 *   TOKEN_MANAGER_SECRET - Secret for token manager
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";
import { parse } from "smol-toml";

const DOCS_DIR = join(process.cwd(), "docs");

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
    const resetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
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
    return await getTokenFromManager();
  } catch (e) {
    console.error(`Error rotating token: ${e.message}`);
    return null;
  }
}

// Get GitHub token
async function getGitHubToken() {
  if (!currentToken) {
    const managerToken = await getTokenFromManager();
    if (managerToken) return managerToken;
  } else {
    return currentToken;
  }
  return process.env.GITHUB_TOKEN || null;
}

// Fetch versions with timestamps from mise
async function fetchVersionsWithTimestamps(tool, retries = 2) {
  const token = await getGitHubToken();
  const env = { ...process.env };
  if (token) {
    env.GITHUB_TOKEN = token;
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const output = execSync(`mise ls-remote --json "${tool}"`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env,
        timeout: 60000,
      });

      if (!output || !output.trim()) {
        console.log(`  Empty output from mise ls-remote for ${tool}`);
        return null;
      }

      const data = JSON.parse(output);
      // Returns array of { version, created_at? }
      return data;
    } catch (e) {
      const stderr = e.stderr?.toString() || "";
      const stdout = e.stdout?.toString() || "";
      // Check for rate limiting
      if (stderr.includes("rate limit") || stderr.includes("403")) {
        console.log(`  Rate limited on ${tool}, rotating token...`);
        const newToken = await rotateToken();
        if (newToken) {
          env.GITHUB_TOKEN = newToken;
          continue;
        }
      }
      if (attempt === retries) {
        // Log the actual error for debugging
        if (stderr) {
          console.log(`  stderr: ${stderr.slice(0, 200)}`);
        }
        if (e.message && !stderr) {
          console.log(`  error: ${e.message.slice(0, 200)}`);
        }
        return null;
      }
    }
  }
  return null;
}

// Parse command line arguments
function parseArgs() {
  const args = {
    tool: null,
    dryRun: false,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg.startsWith("--tool=")) {
      args.tool = arg.slice(7);
    }
  }

  return args;
}

// Check if timestamps contain placeholder values
// Tools with 2025-01-01T00:00:00.000Z are placeholders from initial backfill
function hasPlaceholderTimestamps(versions) {
  const PLACEHOLDER = "2025-01-01T00:00:00.000Z";
  for (const data of Object.values(versions)) {
    const ts = data.created_at;
    // Handle both string and Date object from TOML parser
    const tsStr = ts instanceof Date ? ts.toISOString() : String(ts);
    if (tsStr === PLACEHOLDER) {
      return true;
    }
  }
  return false;
}

async function main() {
  const args = parseArgs();

  console.log("Backfilling created_at timestamps...");
  if (args.dryRun) {
    console.log("DRY RUN - no files will be modified");
  }

  // Initialize token
  await getGitHubToken();

  // Find all TOML files
  const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".toml"));
  console.log(`Found ${files.length} TOML files`);

  // Filter to specific tool if requested
  let toolsToProcess = files.map((f) => basename(f, ".toml"));
  if (args.tool) {
    if (!toolsToProcess.includes(args.tool)) {
      console.error(`Tool "${args.tool}" not found`);
      process.exit(1);
    }
    toolsToProcess = [args.tool];
  }

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const tool of toolsToProcess) {
    processed++;
    if (processed % 10 === 0) {
      process.stdout.write(`\rProcessing ${processed}/${toolsToProcess.length}...`);
    }

    const tomlPath = join(DOCS_DIR, `${tool}.toml`);

    // Read existing TOML
    let existing;
    try {
      const content = readFileSync(tomlPath, "utf-8");
      existing = parse(content);
    } catch (e) {
      console.error(`\nFailed to parse ${tool}.toml: ${e.message}`);
      failed++;
      continue;
    }

    if (!existing.versions || Object.keys(existing.versions).length === 0) {
      skipped++;
      continue;
    }

    // Check if timestamps contain placeholders
    if (!hasPlaceholderTimestamps(existing.versions)) {
      skipped++;
      continue;
    }

    console.log(`\n[${processed}/${toolsToProcess.length}] ${tool} has placeholder timestamps, fetching real data...`);

    // Fetch real timestamps from mise
    const versionData = await fetchVersionsWithTimestamps(tool);
    if (!versionData) {
      console.log(`  Failed to fetch versions for ${tool}`);
      failed++;
      continue;
    }

    // Build map of version -> created_at from API
    const apiTimestamps = new Map();
    for (const v of versionData) {
      if (v.created_at) {
        apiTimestamps.set(v.version, v.created_at);
      }
    }

    if (apiTimestamps.size === 0) {
      console.log(`  No timestamps available from API for ${tool}`);
      skipped++;
      continue;
    }

    // Update TOML with real timestamps
    let changedCount = 0;
    let notFoundCount = 0;
    const lines = ["[versions]"];

    for (const [version, data] of Object.entries(existing.versions)) {
      const apiTs = apiTimestamps.get(version);
      // Handle Date object from TOML parser
      let timestamp = data.created_at instanceof Date
        ? data.created_at.toISOString()
        : String(data.created_at);

      const isPlaceholder = timestamp === "2025-01-01T00:00:00.000Z";

      if (apiTs) {
        const apiDate = new Date(apiTs).toISOString();
        if (timestamp !== apiDate) {
          timestamp = apiDate;
          changedCount++;
        }
      } else if (isPlaceholder) {
        // Version not in API and has placeholder - count but keep placeholder
        notFoundCount++;
      }

      lines.push(`"${version}" = { created_at = ${timestamp} }`);
    }

    if (changedCount === 0) {
      if (notFoundCount > 0) {
        console.log(`  No API data for ${notFoundCount} versions in ${tool}`);
      } else {
        console.log(`  No changes needed for ${tool}`);
      }
      skipped++;
      continue;
    }

    console.log(`  Updated ${changedCount} timestamps for ${tool}${notFoundCount > 0 ? ` (${notFoundCount} not in API)` : ""}`);

    if (!args.dryRun) {
      writeFileSync(tomlPath, lines.join("\n") + "\n");
    }
    updated++;
  }

  console.log(`\n\nDone!`);
  console.log(`  Processed: ${processed}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Failed: ${failed}`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
