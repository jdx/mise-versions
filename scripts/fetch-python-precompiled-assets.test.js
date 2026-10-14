#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, it } from "node:test";
import {
  fetchPythonPrecompiledAssets,
  pythonPrecompiledNames,
} from "./fetch-python-precompiled-assets.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function docsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "pp-docs-"));
  for (const file of files) writeFileSync(join(dir, file), "");
  return dir;
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

  it("writes the source bytes unchanged and skips lists the source lacks", async () => {
    const bodies = {
      "/tools/python-precompiled.gz": gzipSync("all"),
      "/tools/python-precompiled-x86_64-unknown-linux-gnu.gz": gzipSync("x86"),
    };
    globalThis.fetch = async (url) => {
      const body = bodies[new URL(url).pathname];
      return body
        ? new Response(body, {
            headers: { "Content-Type": "application/gzip" },
          })
        : new Response("missing", { status: 404 });
    };
    const outputDir = mkdtempSync(join(tmpdir(), "pp-out-"));
    const result = await fetchPythonPrecompiledAssets({
      docsDir: docsDir([
        "python-precompiled.toml",
        "python-precompiled-x86_64-unknown-linux-gnu.toml",
        "python-precompiled-riscv64-unknown-linux-gnu.toml",
      ]),
      outputDir,
      sourceUrl: "https://example.test/",
    });
    assert.deepEqual(result.missing, [
      "python-precompiled-riscv64-unknown-linux-gnu",
    ]);
    assert.deepEqual(readdirSync(outputDir).sort(), [
      "python-precompiled-x86_64-unknown-linux-gnu.gz",
      "python-precompiled.gz",
    ]);
    assert.deepEqual(
      readFileSync(join(outputDir, "python-precompiled.gz")),
      bodies["/tools/python-precompiled.gz"],
    );
  });

  it("fails rather than publishing a non-gzip body", async () => {
    globalThis.fetch = async () => new Response("<html>");
    await assert.rejects(
      fetchPythonPrecompiledAssets({
        docsDir: docsDir(["python-precompiled.toml"]),
        outputDir: mkdtempSync(join(tmpdir(), "pp-out-")),
        sourceUrl: "https://example.test",
        attempts: 1,
      }),
      /not gzip/,
    );
  });
});
