import { test } from "node:test";
import assert from "node:assert/strict";
import { readDirectoryState, directoryQuery } from "./directory-state";

test("directory links preserve search, sorting, backend selection, and pagination", () => {
  const state = {
    page: 3,
    search: "c++ & tools",
    sort: "updated" as const,
    backends: ["aqua", "github"],
  };
  assert.deepEqual(readDirectoryState(directoryQuery(state)), state);
});
test("empty filters return the canonical directory and malformed links use defaults", () => {
  const defaults = {
    page: 1,
    search: "",
    sort: "downloads" as const,
    backends: [],
  };
  assert.equal(directoryQuery(defaults), "");
  assert.deepEqual(
    readDirectoryState("?page=-1&sort=other&backends=,,"),
    defaults,
  );
  assert.equal(readDirectoryState("?page=1.5").page, 1);
  assert.equal(readDirectoryState("?page=garbage").page, 1);
});
test("search trims whitespace and encodes slashes, plus signs and ampersands", () => {
  const query = directoryQuery({ search: "  foo/bar+c&d  " });
  assert.equal(readDirectoryState(query).search, "foo/bar+c&d");
  assert.equal(directoryQuery({ search: "  " }), "");
});
