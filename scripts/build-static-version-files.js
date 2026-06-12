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
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

  return { tools: files.length };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  const [docsDir, outputDir] = process.argv.slice(2);
  const result = buildStaticVersionFiles({ docsDir, outputDir });
  console.log(`Generated static version files for ${result.tools} tools`);
}
