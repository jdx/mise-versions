#!/usr/bin/env node
/**
 * Sync tool metadata to D1 database via API.
 *
 * Usage: node sync-to-d1.js
 *
 * Environment variables:
 *   SYNC_API_URL - Base URL of the API (e.g., https://mise-tools.jdx.dev)
 *   API_SECRET   - API secret for authentication
 *
 * Reads docs/tools.json and POSTs to /api/admin/tools/sync
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const DOCS_DIR = join(process.cwd(), "docs");
const TOOLS_FILE = join(DOCS_DIR, "tools.json");

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

  // Load tools.json
  if (!existsSync(TOOLS_FILE)) {
    console.error(`Error: ${TOOLS_FILE} not found. Run generate-manifest.js first.`);
    process.exit(1);
  }

  const toolsData = JSON.parse(readFileSync(TOOLS_FILE, "utf-8"));
  console.log(`Loaded ${toolsData.tools.length} tools from tools.json`);

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
      body: JSON.stringify({ tools: toolsData.tools }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`Sync failed: ${response.status} ${response.statusText}`);
      console.error(text);
      process.exit(1);
    }

    const result = await response.json();
    console.log("Sync completed successfully:");
    console.log(`  - Inserted: ${result.inserted}`);
    console.log(`  - Updated: ${result.updated}`);
    console.log(`  - Errors: ${result.errors}`);
    console.log(`  - Total: ${result.total}`);

    if (result.errors > 0) {
      console.warn(`Warning: ${result.errors} tools failed to sync`);
      process.exit(1);
    }
  } catch (e) {
    console.error("Sync failed:", e.message);
    process.exit(1);
  }
}

main();
