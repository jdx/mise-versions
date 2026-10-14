#!/usr/bin/env node
/**
 * Generate static version files served from /data/*: one <tool>.toml per tool
 * and the versions index (see build-versions-index.js), both from the same
 * docs/ checkout so the index is never staler than the per-tool files.
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

function assertSafeOutputDir(docsDir, outputDir) {
  if (!existsSync(docsDir)) {
    throw new Error(`Docs directory not found: ${docsDir}`);
  }
  if (!statSync(docsDir).isDirectory()) {
    throw new Error(`Docs path is not a directory: ${docsDir}`);
  }

  const resolvedDocsDir = resolve(docsDir);
  const resolvedOutputDir = resolve(outputDir);
  const docsRelativeToOutput = relative(resolvedOutputDir, resolvedDocsDir);
  if (
    resolvedDocsDir === resolvedOutputDir ||
    (docsRelativeToOutput &&
      !docsRelativeToOutput.startsWith("..") &&
      !docsRelativeToOutput.startsWith("/"))
  ) {
    throw new Error("outputDir must not be the docsDir or contain docsDir");
  }

  return { docsDir: resolvedDocsDir, outputDir: resolvedOutputDir };
}

export function buildStaticVersionFiles({
  docsDir = join(REPO_ROOT, "docs"),
  outputDir = join(REPO_ROOT, "web", "public", "data"),
  now = Date.now(),
} = {}) {
  const paths = assertSafeOutputDir(docsDir, outputDir);

  rmSync(paths.outputDir, { recursive: true, force: true });
  mkdirSync(paths.outputDir, { recursive: true });

  const files = readdirSync(paths.docsDir)
    .filter((file) => file.endsWith(".toml"))
    .sort();

  for (const file of files) {
    const tomlContent = readFileSync(join(paths.docsDir, file), "utf8");
    writeFileSync(join(paths.outputDir, file), tomlContent);
  }

  const index = buildVersionsIndex({ docsDir: paths.docsDir, now });
  writeFileSync(join(paths.outputDir, INDEX_FILE), JSON.stringify(index));

  return { tools: files.length, indexed: Object.keys(index.tools).length };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  const [docsDir, outputDir] = process.argv.slice(2);
  const result = buildStaticVersionFiles({ docsDir, outputDir });
  console.log(
    `Generated static version files for ${result.tools} tools and ${INDEX_FILE} for ${result.indexed}`,
  );
}
