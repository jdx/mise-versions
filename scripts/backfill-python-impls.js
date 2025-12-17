#!/usr/bin/env node
/**
 * One-time backfill of Python implementation release dates from GitHub.
 * Handles PyPy, Micropython, Jython, GraalPy, Pyston, IronPython, Stackless.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parse } from "smol-toml";

const DOCS_DIR = join(process.cwd(), "docs");
const TOML_PATH = join(DOCS_DIR, "python.toml");
const PLACEHOLDER = "2025-01-01T00:00:00.000Z";

// Map of implementation prefixes to GitHub repos and tag patterns
const IMPLEMENTATIONS = {
  pypy: {
    repo: "pypy/pypy",
    // Tags like "release-pypy2.7-v7.3.12", "release-pypy3.10-v7.3.12", "release-v7.3.0"
    tagToVersion: (tag) => {
      // release-pypy2.7-v7.3.12 -> pypy2.7-7.3.12
      // release-pypy3.10-v7.3.12 -> pypy3.10-7.3.12
      // release-v5.0.0 -> pypy-5.0.0
      let m = tag.match(/^release-pypy(\d+\.\d+)-v(.+)$/);
      if (m) return `pypy${m[1]}-${m[2]}`;
      m = tag.match(/^release-v(.+)$/);
      if (m) return `pypy-${m[1]}`;
      return null;
    },
    versionPatterns: [/^pypy\d*\.?\d*-/, /^pypy-/],
  },
  micropython: {
    repo: "micropython/micropython",
    // Tags like "v1.21.0"
    tagToVersion: (tag) => {
      const m = tag.match(/^v(.+)$/);
      return m ? `micropython-${m[1]}` : null;
    },
    versionPatterns: [/^micropython-\d/],
  },
  jython: {
    repo: "jython/jython",
    // Tags like "v2.7.3"
    tagToVersion: (tag) => {
      const m = tag.match(/^v(.+)$/);
      return m ? `jython-${m[1]}` : null;
    },
    versionPatterns: [/^jython-\d/],
  },
  graalpy: {
    repo: "oracle/graalpython",
    // Tags like "graal-23.1.0", "vm-23.1.0"
    tagToVersion: (tag) => {
      let m = tag.match(/^(?:graal|vm)-(\d+\.\d+\.\d+)$/);
      if (m) return `graalpy-${m[1]}`;
      m = tag.match(/^jdk-(\d+\.\d+\.\d+)$/);
      if (m) return `graalpython-${m[1]}`;
      return null;
    },
    versionPatterns: [/^graalpy-\d/, /^graalpy-community-/, /^graalpython-/],
  },
  pyston: {
    repo: "pyston/pyston",
    // Tags like "pyston_2.3.5", "v2.2"
    tagToVersion: (tag) => {
      let m = tag.match(/^pyston_(.+)$/);
      if (m) return `pyston-${m[1]}`;
      m = tag.match(/^v(.+)$/);
      if (m) return `pyston-${m[1]}`;
      return null;
    },
    versionPatterns: [/^pyston-\d/],
  },
  ironpython: {
    repo: "IronLanguages/ironpython2",
    // Tags like "ipy-2.7.12"
    tagToVersion: (tag) => {
      const m = tag.match(/^ipy-(.+)$/);
      return m ? `ironpython-${m[1]}` : null;
    },
    versionPatterns: [/^ironpython-\d/],
  },
  stackless: {
    repo: "stackless-dev/stackless",
    // Tags like "v3.7.5-slp", "v2.7.16-slp"
    tagToVersion: (tag) => {
      const m = tag.match(/^v(.+)-slp$/);
      return m ? `stackless-${m[1]}` : null;
    },
    versionPatterns: [/^stackless-\d/],
  },
};

async function fetchGitHubTags(repo, page = 1) {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "mise-versions-backfill",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const url = `https://api.github.com/repos/${repo}/tags?per_page=100&page=${page}`;
  const response = await fetch(url, { headers });

  if (!response.ok) {
    if (response.status === 404) return [];
    throw new Error(`GitHub API error for ${repo}: ${response.status}`);
  }

  return response.json();
}

async function fetchTagDate(repo, tagName) {
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "mise-versions-backfill",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const url = `https://api.github.com/repos/${repo}/git/refs/tags/${encodeURIComponent(tagName)}`;
  const response = await fetch(url, { headers });

  if (!response.ok) return null;

  const ref = await response.json();
  const objResponse = await fetch(ref.object.url, { headers });
  if (!objResponse.ok) return null;

  const obj = await objResponse.json();

  if (obj.tagger?.date) return obj.tagger.date;
  if (obj.committer?.date) return obj.committer.date;

  if (obj.object?.url) {
    const commitResponse = await fetch(obj.object.url, { headers });
    if (commitResponse.ok) {
      const commit = await commitResponse.json();
      return commit.committer?.date || commit.author?.date;
    }
  }

  return null;
}

async function getAllTags(repo, tagToVersion) {
  const allTags = new Map();
  let page = 1;

  while (true) {
    const tags = await fetchGitHubTags(repo, page);
    if (tags.length === 0) break;

    for (const tag of tags) {
      const version = tagToVersion(tag.name);
      if (version && !allTags.has(version)) {
        allTags.set(version, tag.name);
      }
    }

    page++;
    await new Promise((r) => setTimeout(r, 100));
  }

  return allTags;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const implFilter = process.argv.find((a) => a.startsWith("--impl="))?.slice(7);

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

  // Collect all dates
  const allDates = new Map();

  for (const [name, config] of Object.entries(IMPLEMENTATIONS)) {
    if (implFilter && name !== implFilter) continue;

    console.log(`\n=== ${name} (${config.repo}) ===`);

    // Find versions needing backfill
    const versionsToBackfill = [];
    for (const [version, data] of Object.entries(existing.versions)) {
      const matches = config.versionPatterns.some((p) => p.test(version));
      if (!matches) continue;

      const ts =
        data.created_at instanceof Date
          ? data.created_at.toISOString()
          : String(data.created_at);

      if (ts === PLACEHOLDER) {
        versionsToBackfill.push(version);
      }
    }

    if (versionsToBackfill.length === 0) {
      console.log("  No versions need backfill");
      continue;
    }

    console.log(`  ${versionsToBackfill.length} versions need backfill`);

    // Fetch tags
    console.log(`  Fetching tags from GitHub...`);
    const tagMap = await getAllTags(config.repo, config.tagToVersion);
    console.log(`  Found ${tagMap.size} matching tags`);

    // Fetch dates
    let fetched = 0;
    for (const version of versionsToBackfill) {
      const tagName = tagMap.get(version);
      if (!tagName) {
        // Try alternate lookups for some implementations
        continue;
      }

      const date = await fetchTagDate(config.repo, tagName);
      if (date) {
        allDates.set(version, new Date(date).toISOString());
        fetched++;
        console.log(`    ${version}: ${date}`);
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    console.log(`  Fetched ${fetched} dates`);
  }

  if (allDates.size === 0) {
    console.log("\nNo dates to update!");
    return;
  }

  // Update TOML
  const lines = ["[versions]"];
  let updated = 0;

  for (const [version, data] of Object.entries(existing.versions)) {
    let timestamp =
      data.created_at instanceof Date
        ? data.created_at.toISOString()
        : String(data.created_at);

    if (allDates.has(version)) {
      timestamp = allDates.get(version);
      updated++;
    }

    lines.push(`"${version}" = { created_at = ${timestamp} }`);
  }

  if (!dryRun) {
    writeFileSync(TOML_PATH, lines.join("\n") + "\n");
    console.log(`\nUpdated ${updated} timestamps in python.toml`);
  } else {
    console.log(`\nWould update ${updated} timestamps in python.toml`);
  }
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
