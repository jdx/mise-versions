#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, it } from "node:test";
import {
  fetchPythonPrecompiledAssets,
  pythonPrecompiledNames,
} from "./fetch-python-precompiled-assets.js";

function docsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "pp-docs-"));
  for (const file of files) writeFileSync(join(dir, file), "");
  return dir;
}

function fakeR2(objects) {
  const keys = [];
  return {
    keys,
    async getObject(key) {
      keys.push(key);
      return objects[key] ?? null;
    },
  };
}

describe("fetch-python-precompiled-assets", () => {
  it("derives one list per python-precompiled TOML", () => {
    const dir = docsDir([
      "python-precompiled.toml",
      "python-precompiled-x86_64-unknown-linux-gnu.toml",
      "python-precompiled-aarch64-apple-darwin-freethreaded.toml",
      "python.toml",
      "node.toml",
    ]);
    assert.deepEqual(pythonPrecompiledNames(dir), [
      "python-precompiled",
      "python-precompiled-aarch64-apple-darwin-freethreaded",
      "python-precompiled-x86_64-unknown-linux-gnu",
    ]);
  });

  it("copies the R2 objects byte for byte", async () => {
    const objects = {
      "tools/python-precompiled.gz": gzipSync("all"),
      "tools/python-precompiled-x86_64-unknown-linux-gnu.gz": gzipSync("x86"),
    };
    const outputDir = mkdtempSync(join(tmpdir(), "pp-out-"));
    const result = await fetchPythonPrecompiledAssets({
      r2: fakeR2(objects),
      docsDir: docsDir([
        "python-precompiled.toml",
        "python-precompiled-x86_64-unknown-linux-gnu.toml",
      ]),
      outputDir,
    });
    assert.deepEqual(result.written, [
      "python-precompiled",
      "python-precompiled-x86_64-unknown-linux-gnu",
    ]);
    assert.deepEqual(readdirSync(outputDir).sort(), [
      "python-precompiled-x86_64-unknown-linux-gnu.gz",
      "python-precompiled.gz",
    ]);
    assert.deepEqual(
      readFileSync(join(outputDir, "python-precompiled.gz")),
      objects["tools/python-precompiled.gz"],
    );
  });

  it("fails without writing anything when an expected list is missing", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "pp-out-"));
    await assert.rejects(
      fetchPythonPrecompiledAssets({
        r2: fakeR2({ "tools/python-precompiled.gz": gzipSync("all") }),
        docsDir: docsDir([
          "python-precompiled.toml",
          "python-precompiled-riscv64-unknown-linux-gnu.toml",
        ]),
        outputDir,
      }),
      /tools\/python-precompiled-riscv64-unknown-linux-gnu.gz not found/,
    );
    assert.deepEqual(readdirSync(outputDir), []);
  });

  it("fails rather than publishing a non-gzip object", async () => {
    await assert.rejects(
      fetchPythonPrecompiledAssets({
        r2: fakeR2({ "tools/python-precompiled.gz": Buffer.from("<html>") }),
        docsDir: docsDir(["python-precompiled.toml"]),
        outputDir: mkdtempSync(join(tmpdir(), "pp-out-")),
      }),
      /not gzip/,
    );
  });
});
