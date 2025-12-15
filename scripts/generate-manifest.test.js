#!/usr/bin/env node
/**
 * Tests for generate-manifest.js
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import {
  writeFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT_PATH = new URL("./generate-manifest.js", import.meta.url).pathname;

/**
 * Run generate-manifest.js in a given directory
 */
function runGenerateManifest(cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SCRIPT_PATH], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, code });
    });

    proc.on("error", reject);
  });
}

describe("generate-manifest.js", () => {
  let tempDir;
  let docsDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "generate-manifest-test-"));
    docsDir = join(tempDir, "docs");
    mkdirSync(docsDir);
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  describe("basic functionality", () => {
    it("should generate tools.json from TOML files", async () => {
      writeFileSync(
        join(docsDir, "node.toml"),
        `[versions]
"18.0.0" = { created_at = 2022-04-19T00:00:00Z }
"20.0.0" = { created_at = 2023-04-18T00:00:00Z }
`
      );

      const { code } = await runGenerateManifest(tempDir);
      assert.strictEqual(code, 0);

      const manifest = JSON.parse(readFileSync(join(docsDir, "tools.json"), "utf-8"));
      assert.ok(manifest.tools);
      assert.strictEqual(manifest.tools.length, 1);
      assert.strictEqual(manifest.tools[0].name, "node");
    });

    it("should include tool_count", async () => {
      writeFileSync(
        join(docsDir, "node.toml"),
        `[versions]
"20.0.0" = { created_at = 2023-04-18T00:00:00Z }
`
      );
      writeFileSync(
        join(docsDir, "python.toml"),
        `[versions]
"3.12.0" = { created_at = 2023-10-02T00:00:00Z }
`
      );

      const { code } = await runGenerateManifest(tempDir);
      assert.strictEqual(code, 0);

      const manifest = JSON.parse(readFileSync(join(docsDir, "tools.json"), "utf-8"));
      assert.strictEqual(manifest.tool_count, 2);
    });
  });

  describe("version ordering", () => {
    it("should use last version as latest (not sorted)", async () => {
      // mise ls-remote returns oldest first, so last entry should be latest
      writeFileSync(
        join(docsDir, "node.toml"),
        `[versions]
"18.0.0" = { created_at = 2022-04-19T00:00:00Z }
"19.0.0" = { created_at = 2022-10-18T00:00:00Z }
"20.0.0" = { created_at = 2023-04-18T00:00:00Z }
`
      );

      const { code } = await runGenerateManifest(tempDir);
      assert.strictEqual(code, 0);

      const manifest = JSON.parse(readFileSync(join(docsDir, "tools.json"), "utf-8"));
      const node = manifest.tools.find((t) => t.name === "node");
      assert.strictEqual(node.latest_version, "20.0.0");
    });

    it("should not sort versions semantically", async () => {
      // Test that it truly takes the last one, not the highest semver
      writeFileSync(
        join(docsDir, "tool.toml"),
        `[versions]
"2.0.0" = { created_at = 2023-01-01T00:00:00Z }
"1.0.0" = { created_at = 2023-06-01T00:00:00Z }
`
      );

      const { code } = await runGenerateManifest(tempDir);
      assert.strictEqual(code, 0);

      const manifest = JSON.parse(readFileSync(join(docsDir, "tools.json"), "utf-8"));
      const tool = manifest.tools.find((t) => t.name === "tool");
      // Should be 1.0.0 because it's last in the TOML, not 2.0.0
      assert.strictEqual(tool.latest_version, "1.0.0");
    });
  });

  describe("metadata extraction", () => {
    it("should count versions correctly", async () => {
      writeFileSync(
        join(docsDir, "node.toml"),
        `[versions]
"18.0.0" = { created_at = 2022-04-19T00:00:00Z }
"19.0.0" = { created_at = 2022-10-18T00:00:00Z }
"20.0.0" = { created_at = 2023-04-18T00:00:00Z }
"21.0.0" = { created_at = 2023-10-17T00:00:00Z }
"22.0.0" = { created_at = 2024-04-24T00:00:00Z }
`
      );

      const { code } = await runGenerateManifest(tempDir);
      assert.strictEqual(code, 0);

      const manifest = JSON.parse(readFileSync(join(docsDir, "tools.json"), "utf-8"));
      const node = manifest.tools.find((t) => t.name === "node");
      assert.strictEqual(node.version_count, 5);
    });

    it("should find most recent created_at as last_updated", async () => {
      writeFileSync(
        join(docsDir, "node.toml"),
        `[versions]
"20.0.0" = { created_at = 2023-04-18T00:00:00Z }
"18.19.0" = { created_at = 2024-01-01T00:00:00Z }
"21.0.0" = { created_at = 2023-10-17T00:00:00Z }
`
      );

      const { code } = await runGenerateManifest(tempDir);
      assert.strictEqual(code, 0);

      const manifest = JSON.parse(readFileSync(join(docsDir, "tools.json"), "utf-8"));
      const node = manifest.tools.find((t) => t.name === "node");
      assert.strictEqual(node.last_updated, "2024-01-01T00:00:00.000Z");
    });
  });

  describe("Date object handling", () => {
    it("should handle Date objects from TOML parser", async () => {
      // smol-toml parses datetime as Date objects
      writeFileSync(
        join(docsDir, "node.toml"),
        `[versions]
"20.0.0" = { created_at = 2023-04-18T00:00:00Z }
`
      );

      const { code } = await runGenerateManifest(tempDir);
      assert.strictEqual(code, 0);

      const manifest = JSON.parse(readFileSync(join(docsDir, "tools.json"), "utf-8"));
      const node = manifest.tools.find((t) => t.name === "node");
      // Should be a valid ISO string
      assert.ok(node.last_updated);
      assert.ok(new Date(node.last_updated).getTime() > 0);
    });
  });

  describe("edge cases", () => {
    it("should skip empty TOML files", async () => {
      writeFileSync(join(docsDir, "empty.toml"), "[versions]\n");

      writeFileSync(
        join(docsDir, "node.toml"),
        `[versions]
"20.0.0" = { created_at = 2023-04-18T00:00:00Z }
`
      );

      const { code } = await runGenerateManifest(tempDir);
      assert.strictEqual(code, 0);

      const manifest = JSON.parse(readFileSync(join(docsDir, "tools.json"), "utf-8"));
      // Should only have node, not empty
      assert.strictEqual(manifest.tool_count, 1);
      assert.strictEqual(manifest.tools[0].name, "node");
    });

    it("should handle malformed TOML gracefully", async () => {
      writeFileSync(join(docsDir, "bad.toml"), "this is not valid toml {{{");

      writeFileSync(
        join(docsDir, "node.toml"),
        `[versions]
"20.0.0" = { created_at = 2023-04-18T00:00:00Z }
`
      );

      const { stderr, code } = await runGenerateManifest(tempDir);
      assert.strictEqual(code, 0);

      // Should warn about malformed file
      assert.ok(stderr.includes("Warning"));

      // Should still process valid files
      const manifest = JSON.parse(readFileSync(join(docsDir, "tools.json"), "utf-8"));
      assert.strictEqual(manifest.tool_count, 1);
    });

    it("should sort tools alphabetically", async () => {
      writeFileSync(
        join(docsDir, "python.toml"),
        `[versions]
"3.12.0" = { created_at = 2023-10-02T00:00:00Z }
`
      );
      writeFileSync(
        join(docsDir, "node.toml"),
        `[versions]
"20.0.0" = { created_at = 2023-04-18T00:00:00Z }
`
      );
      writeFileSync(
        join(docsDir, "go.toml"),
        `[versions]
"1.21.0" = { created_at = 2023-08-08T00:00:00Z }
`
      );

      const { code } = await runGenerateManifest(tempDir);
      assert.strictEqual(code, 0);

      const manifest = JSON.parse(readFileSync(join(docsDir, "tools.json"), "utf-8"));
      const names = manifest.tools.map((t) => t.name);
      assert.deepStrictEqual(names, ["go", "node", "python"]);
    });

    it("should handle no TOML files", async () => {
      const { code } = await runGenerateManifest(tempDir);
      assert.strictEqual(code, 0);

      const manifest = JSON.parse(readFileSync(join(docsDir, "tools.json"), "utf-8"));
      assert.strictEqual(manifest.tool_count, 0);
      assert.deepStrictEqual(manifest.tools, []);
    });
  });
});
