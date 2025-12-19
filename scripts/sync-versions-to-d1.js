#!/usr/bin/env node
/**
 * Sync tool versions to D1 database via API.
 *
 * Usage: node sync-versions-to-d1.js
 *
 * Environment variables:
 *   SYNC_API_URL - Base URL of the API (e.g., https://mise-tools.jdx.dev)
 *   API_SECRET   - API secret for authentication
 *   FULL_SYNC    - Set to "true" to sync all tools (default: only sync updated tools)
 *
 * Reads docs/*.toml and POSTs to /api/admin/versions/sync
 * By default, only syncs tools listed in updated_tools.txt (if it exists)
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import * as smolToml from "smol-toml";

const DOCS_DIR = join(process.cwd(), "docs");
const UPDATED_TOOLS_FILE = join(process.cwd(), "updated_tools.txt");
const BATCH_SIZE = 100; // Number of tools per request
const PARALLEL_REQUESTS = 4; // Number of parallel requests

async function main() {
  const apiUrl = process.env.SYNC_API_URL;
  const apiSecret = process.env.API_SECRET;
  const fullSync = process.env.FULL_SYNC === "true";

  if (!apiUrl) {
    console.error("Error: SYNC_API_URL environment variable is required");
    process.exit(1);
  }

  if (!apiSecret) {
    console.error("Error: API_SECRET environment variable is required");
    process.exit(1);
  }

  // Determine which tools to sync
  let toolsToSync = null; // null means all tools
  if (!fullSync && existsSync(UPDATED_TOOLS_FILE)) {
    const updatedTools = readFileSync(UPDATED_TOOLS_FILE, "utf-8")
      .split("\n")
      .map(t => t.trim())
      .filter(t => t.length > 0);

    if (updatedTools.length === 0) {
      console.log("No tools were updated - skipping versions sync");
      return;
    }

    toolsToSync = new Set(updatedTools);
    console.log(`Incremental sync: ${toolsToSync.size} updated tools`);
  } else {
    console.log(fullSync ? "Full sync requested" : "No updated_tools.txt found - doing full sync");
  }

  // Find TOML files (filtered if incremental)
  let files = readdirSync(DOCS_DIR).filter(f => f.endsWith('.toml'));
  if (toolsToSync) {
    files = files.filter(f => toolsToSync.has(basename(f, '.toml')));
  }
  console.log(`Found ${files.length} TOML files to sync`);

  // Parse all TOML files
  const allTools = [];
  let totalVersions = 0;

  for (const file of files) {
    const toolName = basename(file, '.toml');
    const filePath = join(DOCS_DIR, file);

    try {
      const content = readFileSync(filePath, 'utf-8');
      const parsed = smolToml.parse(content);
      const versionsObj = parsed.versions || {};

      const versions = Object.entries(versionsObj).map(([version, data]) => ({
        version,
        created_at: data?.created_at || null,
        release_url: data?.release_url || null,
      }));

      if (versions.length > 0) {
        allTools.push({ tool: toolName, versions });
        totalVersions += versions.length;
      }
    } catch (e) {
      console.error(`Failed to parse ${file}:`, e.message);
    }
  }

  console.log(`Parsed ${allTools.length} tools with ${totalVersions} total versions`);

  // Sync in batches with parallel requests
  const syncUrl = `${apiUrl}/api/admin/versions/sync`;
  let toolsSynced = 0;
  let versionsSynced = 0;
  let errors = 0;

  // Split into batches
  const batches = [];
  for (let i = 0; i < allTools.length; i += BATCH_SIZE) {
    batches.push(allTools.slice(i, i + BATCH_SIZE));
  }

  console.log(`Syncing ${batches.length} batches (${PARALLEL_REQUESTS} parallel requests)...`);

  // Process batches in parallel groups
  for (let i = 0; i < batches.length; i += PARALLEL_REQUESTS) {
    const parallelBatches = batches.slice(i, i + PARALLEL_REQUESTS);
    const batchStart = i + 1;
    const batchEnd = Math.min(i + PARALLEL_REQUESTS, batches.length);

    console.log(`Processing batches ${batchStart}-${batchEnd} of ${batches.length}...`);

    const results = await Promise.allSettled(
      parallelBatches.map(async (batch, idx) => {
        const response = await fetch(syncUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiSecret}`,
          },
          body: JSON.stringify({ tools: batch }),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`${response.status} ${response.statusText}: ${text}`);
        }

        return { batch, result: await response.json() };
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        toolsSynced += result.value.result.tools_processed || 0;
        versionsSynced += result.value.result.versions_upserted || 0;
        errors += result.value.result.errors || 0;
      } else {
        console.error(`Batch sync failed:`, result.reason.message);
        errors += BATCH_SIZE; // Approximate error count
      }
    }
  }

  console.log("\nSync completed:");
  console.log(`  - Tools synced: ${toolsSynced}`);
  console.log(`  - Versions synced: ${versionsSynced}`);
  console.log(`  - Errors: ${errors}`);

  if (errors > 0) {
    console.warn(`\nWarning: ${errors} errors occurred during sync`);
    // Don't exit with error - partial sync is acceptable
  }
}

main();
