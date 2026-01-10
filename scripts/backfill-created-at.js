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
 *   GITHUB_PROXY_URL - URL of GitHub proxy (e.g., https://mise-tools.jdx.dev)
 *   API_SECRET       - Secret for proxy authentication
 *   GITHUB_TOKEN     - Fallback GitHub token (optional)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";
import { parse } from "smol-toml";

const DOCS_DIR = join(process.cwd(), "docs");
const CONCURRENCY = 30; // Process 30 tools in parallel
const COMMIT_INTERVAL = 100; // Commit every 100 tools

// Fetch versions with timestamps from mise
async function fetchVersionsWithTimestamps(tool, retries = 2, debug = false) {
  // Use GitHub Proxy if available, otherwise fall back to direct GitHub access
  const proxyUrl = process.env.GITHUB_PROXY_URL; // e.g. https://mise-tools.jdx.dev
  const apiSecret = process.env.API_SECRET;
  const githubToken = process.env.GITHUB_TOKEN;

  const env = {
    ...process.env,
    MISE_LIST_ALL_VERSIONS: "1", // Get all versions, not just first page
    MISE_USE_VERSIONS_HOST: "0", // Bypass versions host to get real timestamps from GitHub
  };

  if (proxyUrl && apiSecret) {
    env.MISE_URL_REPLACEMENTS = JSON.stringify({
      "regex:^https://api\\.github\\.com": `${proxyUrl}/gh`,
    });
    env.MISE_GITHUB_TOKEN = apiSecret;
  } else if (githubToken) {
    env.MISE_GITHUB_TOKEN = githubToken;
  }

  if (debug) {
    env.MISE_DEBUG = "1";
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
    if (stderr) {
      console.log(`  stderr: ${stderr.slice(0, 200)}`);
    }
    return null;
  }
}

// Parse command line arguments
function parseArgs() {
  const args = {
    tool: null,
    dryRun: false,
    debug: false,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--debug") {
      args.debug = true;
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
async function processTool(tool, dryRun, debug = false) {
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
  const versionData = await fetchVersionsWithTimestamps(tool, 2, debug);
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

// Commit and push changes
function commitAndPush(message) {
  try {
    // Stage all toml changes
    execSync('git add -A docs/*.toml', { stdio: 'pipe' });
    const status = execSync('git diff --cached --quiet || echo "changes"', { encoding: 'utf-8' });
    if (status.includes('changes')) {
      execSync(`git commit -m "${message}"`, { stdio: 'pipe' });
      console.log(`  Committed: ${message}`);
      // Pull and push
      try {
        execSync('git pull --rebase origin main', { stdio: 'pipe' });
      } catch (e) {
        // Ignore pull errors if no remote changes
      }
      execSync('git push', { stdio: 'pipe' });
      console.log(`  Pushed to origin`);
      return true;
    }
  } catch (e) {
    console.log(`  Commit/push error: ${e.message}`);
  }
  return false;
}

// Process tools in parallel with concurrency limit
async function processInParallel(tools, dryRun, debug = false) {
  const results = { updated: 0, skipped: 0, failed: 0 };
  let completed = 0;
  let uncommittedUpdates = 0;
  let batchNumber = 0;

  // Process in batches
  for (let i = 0; i < tools.length; i += CONCURRENCY) {
    const batch = tools.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(tool => processTool(tool, dryRun, debug))
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

    // Commit and push periodically
    if (!dryRun && uncommittedUpdates >= COMMIT_INTERVAL) {
      batchNumber++;
      commitAndPush(`chore: backfill created_at timestamps (batch ${batchNumber})`);
      uncommittedUpdates = 0;
    }

    // Progress update
    if (completed % 100 === 0) {
      console.log(`Progress: ${completed}/${tools.length} (${results.updated} updated, ${results.skipped} skipped, ${results.failed} failed)`);
    }
  }

  // Final commit and push for remaining updates
  if (!dryRun && uncommittedUpdates > 0) {
    commitAndPush(`chore: backfill created_at timestamps (final)`);
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
  if (args.debug) {
    console.log("DEBUG MODE - MISE_DEBUG=1 will be set");
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

  const results = await processInParallel(toolsToProcess, args.dryRun, args.debug);

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
