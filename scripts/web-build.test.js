#!/usr/bin/env node
/**
 * Regression tests for the built Astro/Tailwind output.
 *
 * These assume `npm run build -w web` has already run. CI does that before
 * `npm run test`, which keeps this test focused on verifying the artifact.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST_CLIENT_DIR = fileURLToPath(
  new URL("../web/dist/client", import.meta.url),
);
const ASTRO_ASSET_DIR = join(DIST_CLIENT_DIR, "_astro");

function readBuiltCss() {
  assert.ok(
    existsSync(ASTRO_ASSET_DIR),
    "web build assets are missing; run `npm run build -w web` before tests",
  );

  const cssFiles = readdirSync(ASTRO_ASSET_DIR)
    .filter((file) => file.endsWith(".css"))
    .sort();

  assert.ok(cssFiles.length > 0, "web build did not emit a CSS asset");

  return cssFiles
    .map((file) => readFileSync(join(ASTRO_ASSET_DIR, file), "utf8"))
    .join("\n");
}

describe("web build CSS", () => {
  it("includes Tailwind preflight and project utilities", () => {
    const css = readBuiltCss();

    assert.match(
      css,
      /a\{color:inherit;[-a-z:]*text-decoration:inherit/,
      "Tailwind preflight reset is missing",
    );

    const expectedUtilities = [
      ".bg-dark-900{background-color:#0a0a0f}",
      ".bg-dark-800{background-color:#12121a}",
      ".text-neon-purple{color:#b026ff}",
      ".hover\\:text-neon-pink:hover{color:#ff2d95}",
      ".px-4{padding-inline:calc(var(--spacing) * 4)}",
      ".py-8{padding-block:calc(var(--spacing) * 8)}",
      ".text-xl{font-size:var(--text-xl);",
      ".max-w-6xl{max-width:var(--container-6xl)}",
    ];

    for (const utility of expectedUtilities) {
      assert.ok(css.includes(utility), `missing CSS utility: ${utility}`);
    }
  });
});
