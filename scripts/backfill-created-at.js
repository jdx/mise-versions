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
const CONCURRENCY = 30; // Process 30 tools in parallel
const COMMIT_INTERVAL = 100; // Commit every 100 tools

// Get a random token from the token manager for each request
async function getRandomToken() {
  const baseUrl = process.env.TOKEN_MANAGER_URL;
  const secret = process.env.TOKEN_MANAGER_SECRET;

  if (!baseUrl || !secret) {
    return process.env.GITHUB_TOKEN || null;
  }

  try {
    const response = await fetch(`${baseUrl}/api/token`, {
      headers: {
        Authorization: `Bearer ${secret}`,
      },
    });

    if (!response.ok) {
      return process.env.GITHUB_TOKEN || null;
    }

    const data = await response.json();
    return data.token;
  } catch (e) {
    return process.env.GITHUB_TOKEN || null;
  }
}

// Fetch versions with timestamps from mise
async function fetchVersionsWithTimestamps(tool, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Get a fresh random token for each attempt
    const token = await getRandomToken();
    const env = {
      ...process.env,
      MISE_LIST_ALL_VERSIONS: "1",  // Get all versions, not just first page
      MISE_USE_VERSIONS_HOST: "0",  // Bypass versions host to get real timestamps from GitHub
    };
    if (token) {
      env.GITHUB_TOKEN = token;
    }

    try {
      const output = execSync(`mise ls-remote --json "${tool}"`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env,
        timeout: 60000,
      });

      if (!output || !output.trim()) {
        return null;
      }

      const data = JSON.parse(output);
      return data;
    } catch (e) {
      const stderr = e.stderr?.toString() || "";
      // Retry on rate limiting with a new token
      if (stderr.includes("rate limit") || stderr.includes("403")) {
        continue;
      }
      if (attempt === retries) {
        if (stderr) {
          console.log(`  stderr: ${stderr.slice(0, 200)}`);
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

// Process a single tool and return result
async function processTool(tool, dryRun) {
  const tomlPath = join(DOCS_DIR, `${tool}.toml`);

  // Read existing TOML
  let existing;
  try {
    const content = readFileSync(tomlPath, "utf-8");
    existing = parse(content);
  } catch (e) {
    return { tool, status: "failed", error: `Failed to parse: ${e.message}` };
  }

  if (!existing.versions || Object.keys(existing.versions).length === 0) {
    return { tool, status: "skipped", reason: "no versions" };
  }

  // Check if timestamps contain placeholders
  if (!hasPlaceholderTimestamps(existing.versions)) {
    return { tool, status: "skipped", reason: "no placeholders" };
  }

  // Fetch real timestamps from mise
  const versionData = await fetchVersionsWithTimestamps(tool);
  if (!versionData) {
    return { tool, status: "failed", error: "Failed to fetch versions" };
  }

  // Build map of version -> created_at from API
  const apiTimestamps = new Map();
  for (const v of versionData) {
    if (v.created_at) {
      apiTimestamps.set(v.version, v.created_at);
    }
  }

  if (apiTimestamps.size === 0) {
    return { tool, status: "skipped", reason: "no API timestamps" };
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
      notFoundCount++;
    }

    lines.push(`"${version}" = { created_at = ${timestamp} }`);
  }

  if (changedCount === 0) {
    return { tool, status: "skipped", reason: notFoundCount > 0 ? `no API data for ${notFoundCount} versions` : "no changes" };
  }

  if (!dryRun) {
    writeFileSync(tomlPath, lines.join("\n") + "\n");
  }

  return { tool, status: "updated", changedCount, notFoundCount };
}

// Commit changes
function commitChanges(message) {
  try {
    execSync('git add docs/*.toml', { stdio: 'pipe' });
    const status = execSync('git diff --cached --quiet || echo "changes"', { encoding: 'utf-8' });
    if (status.includes('changes')) {
      execSync(`git commit -m "${message}"`, { stdio: 'pipe' });
      console.log(`  Committed: ${message}`);
      return true;
    }
  } catch (e) {
    // Ignore commit errors
  }
  return false;
}

// Process tools in parallel with concurrency limit
async function processInParallel(tools, dryRun) {
  const results = { updated: 0, skipped: 0, failed: 0 };
  let completed = 0;
  let uncommittedUpdates = 0;

  // Process in batches
  for (let i = 0; i < tools.length; i += CONCURRENCY) {
    const batch = tools.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(tool => processTool(tool, dryRun))
    );

    for (const result of batchResults) {
      completed++;
      if (result.status === "updated") {
        results.updated++;
        uncommittedUpdates++;
        console.log(`[${completed}/${tools.length}] ${result.tool}: updated ${result.changedCount} timestamps${result.notFoundCount > 0 ? ` (${result.notFoundCount} not in API)` : ""}`);
      } else if (result.status === "failed") {
        results.failed++;
        console.log(`[${completed}/${tools.length}] ${result.tool}: ${result.error}`);
      } else {
        results.skipped++;
      }
    }

    // Commit periodically
    if (!dryRun && uncommittedUpdates >= COMMIT_INTERVAL) {
      commitChanges(`chore: backfill created_at timestamps (batch ${Math.floor(completed / COMMIT_INTERVAL)})`);
      uncommittedUpdates = 0;
    }

    // Progress update
    if (completed % 100 === 0) {
      console.log(`Progress: ${completed}/${tools.length} (${results.updated} updated, ${results.skipped} skipped, ${results.failed} failed)`);
    }
  }

  // Final commit for remaining updates
  if (!dryRun && uncommittedUpdates > 0) {
    commitChanges(`chore: backfill created_at timestamps (final)`);
  }

  return { ...results, processed: completed };
}

async function main() {
  const args = parseArgs();

  console.log("Backfilling created_at timestamps...");
  console.log(`Concurrency: ${CONCURRENCY}`);
  if (args.dryRun) {
    console.log("DRY RUN - no files will be modified");
  }

  // Find all TOML files, excluding internal tools
  const EXCLUDED_PREFIXES = ["python-precompiled"];
  const files = readdirSync(DOCS_DIR).filter((f) => {
    if (!f.endsWith(".toml")) return false;
    const toolName = basename(f, ".toml");
    return !EXCLUDED_PREFIXES.some((prefix) => toolName.startsWith(prefix));
  });
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

  const results = await processInParallel(toolsToProcess, args.dryRun);

  console.log(`\nDone!`);
  console.log(`  Processed: ${results.processed}`);
  console.log(`  Updated: ${results.updated}`);
  console.log(`  Skipped: ${results.skipped}`);
  console.log(`  Failed: ${results.failed}`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
