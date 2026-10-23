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
  let legacyOutputDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "static-version-files-test-"));
    docsDir = join(tempDir, "docs");
    outputDir = join(tempDir, "public", "data");
    legacyOutputDir = join(tempDir, "public", "tools");
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

    const result = buildStaticVersionFiles({
      docsDir,
      outputDir,
      legacyOutputDir,
    });

    assert.deepStrictEqual(result, { tools: 2, indexed: 2 });
    assert.match(
      readFileSync(join(outputDir, "node.toml"), "utf8"),
      /\[versions\]/,
    );
    assert.match(
      readFileSync(join(outputDir, "python.toml"), "utf8"),
      /\[versions\]/,
    );
    assert.strictEqual(existsSync(join(outputDir, "node")), false);

    const index = JSON.parse(readFileSync(join(outputDir, "index.v1.json")));
    assert.strictEqual(index.format, 1);
    assert.deepStrictEqual(Object.keys(index.tools), ["node", "python"]);
    assert.strictEqual(index.tools.node.latest, "22.0.0");
  });

  it("publishes byte-identical copies at the legacy /tools/*.toml path", () => {
    const nodeToml = `[versions]
"20.0.0" = { created_at = 2024-01-01T00:00:00.000Z }
`;
    writeFileSync(join(docsDir, "node.toml"), nodeToml);
    writeFileSync(join(docsDir, "README.md"), "not a version file\n");
    mkdirSync(legacyOutputDir, { recursive: true });
    writeFileSync(join(legacyOutputDir, "stale.toml"), "stale\n");

    buildStaticVersionFiles({ docsDir, outputDir, legacyOutputDir });

    assert.deepStrictEqual(
      readFileSync(join(legacyOutputDir, "node.toml")),
      readFileSync(join(docsDir, "node.toml")),
    );
    assert.deepStrictEqual(
      readFileSync(join(legacyOutputDir, "node.toml")),
      readFileSync(join(outputDir, "node.toml")),
    );
    assert.strictEqual(existsSync(join(legacyOutputDir, "stale.toml")), false);
    assert.strictEqual(existsSync(join(legacyOutputDir, "README.md")), false);
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

    assert.throws(
      () =>
        buildStaticVersionFiles({
          docsDir,
          outputDir,
          legacyOutputDir: docsDir,
        }),
      /outputDir must not be the docsDir/,
    );

    assert.throws(
      () =>
        buildStaticVersionFiles({
          docsDir,
          outputDir,
          legacyOutputDir: outputDir,
        }),
      /output directories must not overlap/,
    );
  });
});
