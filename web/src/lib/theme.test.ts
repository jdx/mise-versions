import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTheme, resolveTheme } from "./theme";

test("system preference follows the OS while explicit themes override it", () => {
  assert.equal(resolveTheme(parseTheme(null), true), "dark");
  assert.equal(resolveTheme(parseTheme(null), false), "light");
  assert.equal(resolveTheme(parseTheme("light"), true), "light");
  assert.equal(resolveTheme(parseTheme("dark"), false), "dark");
});
test("invalid persisted preferences fall back to system", () => {
  assert.equal(parseTheme("undefined"), "system");
  assert.equal(parseTheme(""), "system");
});
