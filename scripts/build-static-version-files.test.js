#!/usr/bin/env node
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildStaticVersionFiles } from "./build-static-version-files.js";

describe("build-static-version-files.js", () => {
  let tempDir;
  let docsDir;
  let outputDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "static-version-files-test-"));
    docsDir = join(tempDir, "docs");
    outputDir = join(tempDir, "public", "data");
    mkdirSync(docsDir, { recursive: true });
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  it("writes TOML files for each tool", () => {
    writeFileSync(
      join(docsDir, "node.toml"),
      `[versions]
"20.0.0" = { created_at = 2024-01-01T00:00:00.000Z }
"22.0.0" = { created_at = 2024-02-01T00:00:00.000Z }
`,
      { flag: "wx" },
    );
    writeFileSync(
      join(docsDir, "python.toml"),
      `[versions]
"3.12.0" = { created_at = 2024-01-01T00:00:00.000Z }
`,
    );

    const result = buildStaticVersionFiles({ docsDir, outputDir });

    assert.deepStrictEqual(result, { tools: 2 });
    assert.match(
      readFileSync(join(outputDir, "node.toml"), "utf8"),
      /\[versions\]/,
    );
    assert.match(
      readFileSync(join(outputDir, "python.toml"), "utf8"),
      /\[versions\]/,
    );
    assert.strictEqual(existsSync(join(outputDir, "node")), false);
  });

  it("rejects destructive source and output path collisions", () => {
    assert.throws(
      () => buildStaticVersionFiles({ docsDir, outputDir: docsDir }),
      /outputDir must not be the docsDir/,
    );

    assert.throws(
      () => buildStaticVersionFiles({ docsDir, outputDir: tempDir }),
      /outputDir must not be the docsDir/,
    );
  });
});
