#!/usr/bin/env node
/**
 * Sync tool versions to D1 database via API.
 *
 * Usage: node sync-versions-to-d1.js
 *
 * Environment variables:
 *   SYNC_API_URL - Base URL of the API (e.g., https://mise-tools.jdx.dev)
 *   API_SECRET   - API secret for authentication
 *
 * Reads docs/*.toml and POSTs to /api/admin/versions/sync
 */

import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import * as smolToml from "smol-toml";

const DOCS_DIR = join(process.cwd(), "docs");
const BATCH_SIZE = 50; // Number of tools per request

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

  // Find all TOML files
  const files = readdirSync(DOCS_DIR).filter(f => f.endsWith('.toml'));
  console.log(`Found ${files.length} TOML files`);

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

  // Sync in batches
  const syncUrl = `${apiUrl}/api/admin/versions/sync`;
  let toolsSynced = 0;
  let versionsSynced = 0;
  let errors = 0;

  for (let i = 0; i < allTools.length; i += BATCH_SIZE) {
    const batch = allTools.slice(i, i + BATCH_SIZE);
    const batchVersions = batch.reduce((sum, t) => sum + t.versions.length, 0);

    console.log(`Syncing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allTools.length / BATCH_SIZE)} (${batch.length} tools, ${batchVersions} versions)...`);

    try {
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
        console.error(`Batch sync failed: ${response.status} ${response.statusText}`);
        console.error(text);
        errors += batch.length;
        continue;
      }

      const result = await response.json();
      toolsSynced += result.tools_processed || 0;
      versionsSynced += result.versions_upserted || 0;
      errors += result.errors || 0;
    } catch (e) {
      console.error(`Batch sync failed:`, e.message);
      errors += batch.length;
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
