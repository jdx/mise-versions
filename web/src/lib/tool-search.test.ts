import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  buildSearchFilter,
  buildSearchRank,
  escapeLike,
  normalizeSearch,
} from "./tool-search";

interface Row {
  name: string;
  description?: string;
  downloads?: number;
}

// Exercise the fragments the way data-loader composes them, against real
// SQLite, so the ranking is verified rather than string-compared.
function search(rows: Row[], query: string): string[] {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE tools (name TEXT, description TEXT, downloads_30d INTEGER)",
  );
  const insert = db.prepare("INSERT INTO tools VALUES (?, ?, ?)");
  for (const row of rows)
    insert.run(row.name, row.description ?? null, row.downloads ?? 0);

  const normalized = normalizeSearch(query);
  const filter = buildSearchFilter(normalized);
  const rank = buildSearchRank(normalized);
  const results = db
    .prepare(
      `SELECT t.name FROM tools t WHERE ${filter.sql}
       ORDER BY ${rank.sql} ASC, t.downloads_30d DESC, t.name ASC`,
    )
    .all(...filter.params, ...rank.params) as { name: string }[];
  db.close();
  return results.map((r) => r.name);
}

test("an exact name match outranks more popular partial matches", () => {
  const ranked = search(
    [
      { name: "velociraptor", downloads: 900 },
      { name: "ocaml", downloads: 500 },
      { name: "oc", downloads: 10 },
      { name: "kubectl-oc", downloads: 700 },
    ],
    "oc",
  );
  assert.deepEqual(ranked, ["oc", "ocaml", "kubectl-oc", "velociraptor"]);
});

test("prefix matches outrank word matches, which outrank loose substrings", () => {
  const ranked = search(
    [
      { name: "libbuild", downloads: 900 },
      { name: "ruby-build", downloads: 100 },
      { name: "build-tools", downloads: 50 },
    ],
    "build",
  );
  assert.deepEqual(ranked, ["build-tools", "ruby-build", "libbuild"]);
});

test("downloads break ties inside a relevance tier", () => {
  const ranked = search(
    [
      { name: "node-quiet", downloads: 5 },
      { name: "node-loud", downloads: 5000 },
    ],
    "node",
  );
  assert.deepEqual(ranked, ["node-loud", "node-quiet"]);
});

test("descriptions match, but always below every name match", () => {
  const ranked = search(
    [
      {
        name: "helm",
        description: "kubernetes package manager",
        downloads: 900,
      },
      { name: "kubernetes-cli", description: "cluster tool", downloads: 1 },
    ],
    "kubernetes",
  );
  assert.deepEqual(ranked, ["kubernetes-cli", "helm"]);
});

test("short queries do not search descriptions", () => {
  const ranked = search(
    [{ name: "unrelated", description: "runs go programs" }, { name: "go" }],
    "go",
  );
  assert.deepEqual(ranked, ["go"]);
});

test("search is case insensitive and ignores surrounding whitespace", () => {
  assert.deepEqual(search([{ name: "OpenTofu" }], "  OPENTOFU  "), [
    "OpenTofu",
  ]);
  assert.equal(normalizeSearch("  Node  "), "node");
  assert.equal(normalizeSearch(undefined), "");
});

test("LIKE wildcards in a query are matched literally", () => {
  assert.deepEqual(search([{ name: "node" }, { name: "n_de" }], "n_de"), [
    "n_de",
  ]);
  assert.deepEqual(search([{ name: "node" }, { name: "100%" }], "100%"), [
    "100%",
  ]);
  assert.deepEqual(search([{ name: "a\\b" }, { name: "ab" }], "a\\b"), [
    "a\\b",
  ]);
  assert.equal(escapeLike("a_b%c\\d"), "a\\_b\\%c\\\\d");
});

test("separators inside the query stay literal when ranking word matches", () => {
  const ranked = search(
    [
      { name: "x_java_home", downloads: 900 },
      { name: "java_home", downloads: 1 },
    ],
    "java_home",
  );
  assert.deepEqual(ranked, ["java_home", "x_java_home"]);
});
