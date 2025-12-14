#!/usr/bin/env node
/**
 * Tests for generate-toml.js
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "smol-toml";

const SCRIPT_PATH = new URL("./generate-toml.js", import.meta.url).pathname;

/**
 * Run generate-toml.js with given stdin input and arguments
 */
function runGenerateToml(stdinInput, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SCRIPT_PATH, ...args], {
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

    proc.stdin.write(stdinInput);
    proc.stdin.end();
  });
}

describe("generate-toml.js", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "generate-toml-test-"));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  describe("argument validation", () => {
    it("should error when tool name is not provided", async () => {
      const { stderr, code } = await runGenerateToml("");
      assert.strictEqual(code, 1);
      assert.ok(stderr.includes("Usage:"));
    });
  });

  describe("NDJSON parsing", () => {
    it("should parse single version", async () => {
      const input = '{"version":"1.0.0"}\n';
      const { stdout, code } = await runGenerateToml(input, ["test-tool"]);

      assert.strictEqual(code, 0);
      const parsed = parse(stdout);
      assert.ok(parsed.versions);
      assert.ok(parsed.versions["1.0.0"]);
      assert.ok(parsed.versions["1.0.0"].created_at);
    });

    it("should parse multiple versions preserving order", async () => {
      const input = [
        '{"version":"1.0.0"}',
        '{"version":"2.0.0"}',
        '{"version":"1.5.0"}',
      ].join("\n");

      const { stdout, code } = await runGenerateToml(input, ["test-tool"]);
      assert.strictEqual(code, 0);

      const parsed = parse(stdout);
      const versions = Object.keys(parsed.versions);
      assert.deepStrictEqual(versions, ["1.0.0", "2.0.0", "1.5.0"]);
    });

    it("should handle versions with created_at timestamps", async () => {
      const timestamp = "2024-01-15T10:30:00Z";
      const input = `{"version":"1.0.0","created_at":"${timestamp}"}\n`;

      const { stdout, code } = await runGenerateToml(input, ["test-tool"]);
      assert.strictEqual(code, 0);

      const parsed = parse(stdout);
      const createdAt = parsed.versions["1.0.0"].created_at;
      // smol-toml parses dates as Date objects
      assert.ok(createdAt instanceof Date);
      // Compare timestamps (Date.toISOString adds .000 for milliseconds)
      assert.strictEqual(new Date(createdAt).getTime(), new Date(timestamp).getTime());
    });

    it("should skip empty lines", async () => {
      const input = '{"version":"1.0.0"}\n\n{"version":"2.0.0"}\n\n';

      const { stdout, code } = await runGenerateToml(input, ["test-tool"]);
      assert.strictEqual(code, 0);

      const parsed = parse(stdout);
      assert.strictEqual(Object.keys(parsed.versions).length, 2);
    });

    it("should handle malformed JSON lines gracefully", async () => {
      const input = '{"version":"1.0.0"}\nnot json\n{"version":"2.0.0"}\n';

      const { stdout, stderr, code } = await runGenerateToml(input, ["test-tool"]);
      assert.strictEqual(code, 0);

      // Should warn about malformed line
      assert.ok(stderr.includes("Warning"));

      // Should still parse valid lines
      const parsed = parse(stdout);
      assert.strictEqual(Object.keys(parsed.versions).length, 2);
    });
  });

  describe("version formats", () => {
    it("should handle semver versions", async () => {
      const input = '{"version":"1.2.3"}\n';
      const { stdout, code } = await runGenerateToml(input, ["test-tool"]);
      assert.strictEqual(code, 0);
      assert.ok(parse(stdout).versions["1.2.3"]);
    });

    it("should handle versions with pre-release tags", async () => {
      const input = '{"version":"1.0.0-beta.1"}\n';
      const { stdout, code } = await runGenerateToml(input, ["test-tool"]);
      assert.strictEqual(code, 0);
      assert.ok(parse(stdout).versions["1.0.0-beta.1"]);
    });

    it("should handle versions with build metadata", async () => {
      const input = '{"version":"1.0.0+build.123"}\n';
      const { stdout, code } = await runGenerateToml(input, ["test-tool"]);
      assert.strictEqual(code, 0);
      assert.ok(parse(stdout).versions["1.0.0+build.123"]);
    });

    it("should handle calver versions", async () => {
      const input = '{"version":"2024.01.15"}\n';
      const { stdout, code } = await runGenerateToml(input, ["test-tool"]);
      assert.strictEqual(code, 0);
      assert.ok(parse(stdout).versions["2024.01.15"]);
    });

    it("should handle versions with special characters", async () => {
      const input = '{"version":"v1.0.0-rc1"}\n';
      const { stdout, code } = await runGenerateToml(input, ["test-tool"]);
      assert.strictEqual(code, 0);
      assert.ok(parse(stdout).versions["v1.0.0-rc1"]);
    });

    it("should handle Java-style versions", async () => {
      const input = '{"version":"temurin-21.0.1+12"}\n';
      const { stdout, code } = await runGenerateToml(input, ["test-tool"]);
      assert.strictEqual(code, 0);
      assert.ok(parse(stdout).versions["temurin-21.0.1+12"]);
    });
  });

  describe("timestamp preservation", () => {
    it("should preserve existing timestamps when merging", async () => {
      const existingToml = join(tempDir, "existing.toml");
      const existingTimestamp = "2023-06-01T00:00:00.000Z";

      writeFileSync(
        existingToml,
        `[versions]
"1.0.0" = { created_at = ${existingTimestamp} }
`
      );

      const input = '{"version":"1.0.0"}\n{"version":"2.0.0"}\n';
      const { stdout, code } = await runGenerateToml(input, ["test-tool", existingToml]);
      assert.strictEqual(code, 0);

      const parsed = parse(stdout);
      // Existing timestamp should be preserved
      const v1Date = parsed.versions["1.0.0"].created_at;
      assert.strictEqual(v1Date.toISOString(), existingTimestamp);
      // New version should have a timestamp
      assert.ok(parsed.versions["2.0.0"].created_at);
    });

    it("should use API timestamp over existing timestamp", async () => {
      const existingToml = join(tempDir, "existing.toml");
      const existingTimestamp = "2023-06-01T00:00:00.000Z";
      const apiTimestamp = "2024-01-15T10:30:00Z";

      writeFileSync(
        existingToml,
        `[versions]
"1.0.0" = { created_at = ${existingTimestamp} }
`
      );

      const input = `{"version":"1.0.0","created_at":"${apiTimestamp}"}\n`;
      const { stdout, code } = await runGenerateToml(input, ["test-tool", existingToml]);
      assert.strictEqual(code, 0);

      const parsed = parse(stdout);
      // API timestamp should take precedence (compare as timestamps)
      const v1Date = parsed.versions["1.0.0"].created_at;
      assert.strictEqual(new Date(v1Date).getTime(), new Date(apiTimestamp).getTime());
    });

    it("should handle non-existent existing TOML path", async () => {
      const input = '{"version":"1.0.0"}\n';
      const { stdout, code } = await runGenerateToml(input, [
        "test-tool",
        "/nonexistent/path.toml",
      ]);
      assert.strictEqual(code, 0);
      assert.ok(parse(stdout).versions["1.0.0"]);
    });
  });

  describe("TOML output format", () => {
    it("should produce valid TOML output", async () => {
      const input = '{"version":"1.0.0"}\n{"version":"2.0.0"}\n';
      const { stdout, code } = await runGenerateToml(input, ["test-tool"]);
      assert.strictEqual(code, 0);

      // Should not throw
      const parsed = parse(stdout);
      assert.ok(parsed.versions);
    });

    it("should output created_at as TOML datetime", async () => {
      const input = '{"version":"1.0.0","created_at":"2024-01-15T10:30:00Z"}\n';
      const { stdout, code } = await runGenerateToml(input, ["test-tool"]);
      assert.strictEqual(code, 0);

      // Output should contain datetime format
      assert.ok(stdout.includes("created_at"));
      // smol-toml outputs ISO datetimes
      const parsed = parse(stdout);
      assert.ok(parsed.versions["1.0.0"].created_at instanceof Date);
    });
  });
});
