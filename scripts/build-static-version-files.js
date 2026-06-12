#!/usr/bin/env node
/**
 * Generate static version files served from /data/*.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const REPO_ROOT = join(SCRIPT_DIR, "..");

export function buildStaticVersionFiles({
  docsDir = join(REPO_ROOT, "docs"),
  outputDir = join(REPO_ROOT, "web", "public", "data"),
} = {}) {
  if (!existsSync(docsDir)) {
    throw new Error(`Docs directory not found: ${docsDir}`);
  }

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const files = readdirSync(docsDir)
    .filter((file) => file.endsWith(".toml"))
    .sort();

  for (const file of files) {
    const tomlContent = readFileSync(join(docsDir, file), "utf8");
    writeFileSync(join(outputDir, file), tomlContent);
  }

  return { tools: files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  const [docsDir, outputDir] = process.argv.slice(2);
  const result = buildStaticVersionFiles({ docsDir, outputDir });
  console.log(`Generated static version files for ${result.tools} tools`);
}
