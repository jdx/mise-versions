#!/usr/bin/env node
/**
 * One-time backfill of CPython release dates from GitHub.
 * Fetches release dates from python/cpython repository.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parse } from "smol-toml";

const DOCS_DIR = join(process.cwd(), "docs");
const TOML_PATH = join(DOCS_DIR, "python.toml");

// CPython version pattern (e.g., "3.12.0", "2.7.18")
const CPYTHON_PATTERN = /^[23]\.\d+\.\d+$/;

async function fetchGitHubReleases(page = 1) {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "mise-versions-backfill",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const url = `https://api.github.com/repos/python/cpython/tags?per_page=100&page=${page}`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchTagDate(tagName) {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "mise-versions-backfill",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // Get the tag's commit info
  const url = `https://api.github.com/repos/python/cpython/git/refs/tags/${tagName}`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    return null;
  }

  const ref = await response.json();

  // Get the commit or tag object
  const objUrl = ref.object.url;
  const objResponse = await fetch(objUrl, { headers });

  if (!objResponse.ok) {
    return null;
  }

  const obj = await objResponse.json();

  // If it's an annotated tag, get the tagger date
  if (obj.tagger?.date) {
    return obj.tagger.date;
  }

  // If it's a commit, get the committer date
  if (obj.committer?.date) {
    return obj.committer.date;
  }

  // For annotated tags pointing to commits, follow the object
  if (obj.object?.url) {
    const commitResponse = await fetch(obj.object.url, { headers });
    if (commitResponse.ok) {
      const commit = await commitResponse.json();
      return commit.committer?.date || commit.author?.date;
    }
  }

  return null;
}

async function getAllCPythonTags() {
  const allTags = new Map();
  let page = 1;

  console.log("Fetching CPython tags from GitHub...");

  while (true) {
    const tags = await fetchGitHubReleases(page);
    if (tags.length === 0) break;

    for (const tag of tags) {
      // Tags are like "v3.12.0", "v2.7.18"
      const match = tag.name.match(/^v?(\d+\.\d+\.\d+)$/);
      if (match) {
        const version = match[1];
        if (CPYTHON_PATTERN.test(version)) {
          allTags.set(version, tag.name);
        }
      }
    }

    console.log(`  Page ${page}: found ${tags.length} tags (${allTags.size} CPython versions so far)`);
    page++;

    // Rate limit protection
    await new Promise(r => setTimeout(r, 100));
  }

  return allTags;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (dryRun) {
    console.log("DRY RUN - no files will be modified\n");
  }

  // Read existing TOML
  const content = readFileSync(TOML_PATH, "utf-8");
  const existing = parse(content);

  if (!existing.versions) {
    console.error("No versions found in python.toml");
    process.exit(1);
  }

  // Find CPython versions with placeholder timestamps
  const cpythonVersions = [];
  const PLACEHOLDER = "2025-01-01T00:00:00.000Z";

  for (const [version, data] of Object.entries(existing.versions)) {
    if (!CPYTHON_PATTERN.test(version)) continue;

    const ts = data.created_at instanceof Date
      ? data.created_at.toISOString()
      : String(data.created_at);

    if (ts === PLACEHOLDER) {
      cpythonVersions.push(version);
    }
  }

  console.log(`Found ${cpythonVersions.length} CPython versions with placeholder timestamps\n`);

  if (cpythonVersions.length === 0) {
    console.log("Nothing to do!");
    return;
  }

  // Fetch all CPython tags
  const tagMap = await getAllCPythonTags();
  console.log(`\nFound ${tagMap.size} CPython versions on GitHub\n`);

  // Fetch dates for each version
  const dates = new Map();
  let fetched = 0;

  for (const version of cpythonVersions) {
    const tagName = tagMap.get(version);
    if (!tagName) {
      console.log(`  ${version}: no tag found on GitHub`);
      continue;
    }

    const date = await fetchTagDate(tagName);
    if (date) {
      dates.set(version, new Date(date).toISOString());
      fetched++;
      console.log(`  ${version}: ${date}`);
    } else {
      console.log(`  ${version}: could not fetch date`);
    }

    // Rate limit protection
    await new Promise(r => setTimeout(r, 50));
  }

  console.log(`\nFetched dates for ${fetched} versions\n`);

  if (dates.size === 0) {
    console.log("No dates to update!");
    return;
  }

  // Update TOML
  const lines = ["[versions]"];
  let updated = 0;

  for (const [version, data] of Object.entries(existing.versions)) {
    let timestamp = data.created_at instanceof Date
      ? data.created_at.toISOString()
      : String(data.created_at);

    if (dates.has(version)) {
      timestamp = dates.get(version);
      updated++;
    }

    lines.push(`"${version}" = { created_at = ${timestamp} }`);
  }

  if (!dryRun) {
    writeFileSync(TOML_PATH, lines.join("\n") + "\n");
    console.log(`Updated ${updated} timestamps in python.toml`);
  } else {
    console.log(`Would update ${updated} timestamps in python.toml`);
  }
}

main().catch(e => {
  console.error("Error:", e);
  process.exit(1);
});
