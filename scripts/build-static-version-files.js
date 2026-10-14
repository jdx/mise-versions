#!/usr/bin/env node
/**
 * Generate static version files served from /data/* and, for mise clients
 * older than v2026.6.6, from the legacy /tools/*.toml URLs.
 *
 * Both copies are byte-identical to docs/<tool>.toml. wrangler.jsonc excludes
 * /tools/*.toml from run_worker_first, so those requests are answered by the
 * asset worker alone and never invoke the Worker.
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

  return { tools: files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  const [docsDir, outputDir, legacyOutputDir] = process.argv.slice(2);
  const result = buildStaticVersionFiles({
    docsDir,
    outputDir,
    legacyOutputDir,
  });
  console.log(`Generated static version files for ${result.tools} tools`);
}
