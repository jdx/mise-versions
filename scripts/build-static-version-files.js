#!/usr/bin/env node
/**
 * Generate static version files served from /data/*: one <tool>.toml per tool
 * and the versions index (see build-versions-index.js), both from the same
 * docs/ checkout so the index is never staler than the per-tool files.
 *
 * Each <tool>.toml is also copied byte-for-byte to the legacy /tools/*.toml
 * URLs used by mise clients older than v2026.6.6. wrangler.jsonc excludes
 * /tools/*.toml from run_worker_first, so those requests are answered by the
 * asset worker alone and never invoke the Worker. The index is only published
 * under /data.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVersionsIndex, INDEX_FILE } from "./build-versions-index.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const REPO_ROOT = join(SCRIPT_DIR, "..");

function isSameOrInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function assertSafeOutputDirs(docsDir, outputDirs) {
  if (!existsSync(docsDir)) {
    throw new Error(`Docs directory not found: ${docsDir}`);
  }
  if (!statSync(docsDir).isDirectory()) {
    throw new Error(`Docs path is not a directory: ${docsDir}`);
  }

  const resolvedDocsDir = resolve(docsDir);
  const resolvedOutputDirs = outputDirs.map((dir) => resolve(dir));
  for (const [i, outputDir] of resolvedOutputDirs.entries()) {
    if (isSameOrInside(outputDir, resolvedDocsDir)) {
      throw new Error("outputDir must not be the docsDir or contain docsDir");
    }
    for (const other of resolvedOutputDirs.slice(i + 1)) {
      if (
        isSameOrInside(outputDir, other) ||
        isSameOrInside(other, outputDir)
      ) {
        throw new Error("output directories must not overlap");
      }
    }
  }

  return { docsDir: resolvedDocsDir, outputDirs: resolvedOutputDirs };
}

export function buildStaticVersionFiles({
  docsDir = join(REPO_ROOT, "docs"),
  outputDir = join(REPO_ROOT, "web", "public", "data"),
  legacyOutputDir = join(REPO_ROOT, "web", "public", "tools"),
  now = Date.now(),
} = {}) {
  const paths = assertSafeOutputDirs(docsDir, [outputDir, legacyOutputDir]);

  for (const dir of paths.outputDirs) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }

  const files = readdirSync(paths.docsDir)
    .filter((file) => file.endsWith(".toml"))
    .sort();

  for (const file of files) {
    const tomlContent = readFileSync(join(paths.docsDir, file));
    for (const dir of paths.outputDirs) {
      writeFileSync(join(dir, file), tomlContent);
    }
  }

  const index = buildVersionsIndex({ docsDir: paths.docsDir, now });
  // outputDirs[0] is /data; the legacy /tools copy has no index.
  writeFileSync(join(paths.outputDirs[0], INDEX_FILE), JSON.stringify(index));

  return { tools: files.length, indexed: Object.keys(index.tools).length };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  const [docsDir, outputDir, legacyOutputDir] = process.argv.slice(2);
  const result = buildStaticVersionFiles({
    docsDir,
    outputDir,
    legacyOutputDir,
  });
  console.log(
    `Generated static version files for ${result.tools} tools and ${INDEX_FILE} for ${result.indexed}`,
  );
}
