import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { loadToolsPaginated } from "./data-loader";

interface ToolFixture {
  name: string;
  description?: string;
  backends?: string[];
  downloads?: number;
  last_updated?: string;
}

// Minimal stand-in for the D1 client surface loadToolsPaginated uses, backed by
// real SQLite so bind-parameter order is exercised the way Cloudflare does it.
function fakeD1(tools: ToolFixture[]) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tools (
      id INTEGER PRIMARY KEY, name TEXT, latest_version TEXT,
      latest_stable_version TEXT, version_count INTEGER, last_updated TEXT,
      description TEXT, github TEXT, homepage TEXT, repo_url TEXT,
      license TEXT, backends TEXT, authors TEXT, security TEXT,
      package_urls TEXT, aqua_link TEXT
    );
    CREATE TABLE tool_download_summaries (tool_id INTEGER, downloads_30d INTEGER);
    CREATE TABLE backend_tool_summaries (backend_type TEXT, tool_count INTEGER);
    INSERT INTO backend_tool_summaries VALUES ('aqua', 2);
  `);
  const insertTool = db.prepare(
    "INSERT INTO tools (id, name, latest_version, version_count, last_updated, description, backends) VALUES (?, ?, '1.0.0', 1, ?, ?, ?)",
  );
  const insertDownloads = db.prepare(
    "INSERT INTO tool_download_summaries VALUES (?, ?)",
  );
  tools.forEach((tool, i) => {
    insertTool.run(
      i + 1,
      tool.name,
      tool.last_updated ?? "2026-01-01",
      tool.description ?? null,
      JSON.stringify(tool.backends ?? ["aqua:example/tool"]),
    );
    insertDownloads.run(i + 1, tool.downloads ?? 0);
  });

  const run = (query: string, params: unknown[]) => {
    const statement = db.prepare(query);
    return statement.all(...(params as never[]));
  };
  return {
    prepare(query: string) {
      const statement = {
        bind: (...params: unknown[]) => ({
          all: async () => ({ results: run(query, params) }),
          first: async () => run(query, params)[0] ?? null,
        }),
        all: async () => ({ results: run(query, []) }),
        first: async () => run(query, [])[0] ?? null,
      };
      return statement;
    },
  } as unknown as D1Database;
}

test("search results are relevance ranked and counted consistently", async () => {
  const db = fakeD1([
    { name: "velociraptor", downloads: 9000 },
    { name: "ocaml", downloads: 500 },
    { name: "oc", downloads: 10 },
    { name: "node", downloads: 100000 },
  ]);

  const result = await loadToolsPaginated(db, { search: " OC " });
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ["oc", "ocaml", "velociraptor"],
  );
  assert.equal(result.total_count, 3);
  assert.equal(result.downloads.oc, 10);
  assert.deepEqual(result.backendCounts, { aqua: 2 });
});

test("search combines with backend filters and pagination", async () => {
  const db = fakeD1([
    { name: "oc", backends: ["npm:oc"], downloads: 10 },
    { name: "ocaml", backends: ["aqua:ocaml/ocaml"], downloads: 500 },
    { name: "velociraptor", backends: ["aqua:v/v"], downloads: 9000 },
  ]);

  const filtered = await loadToolsPaginated(db, {
    search: "oc",
    backends: ["aqua"],
  });
  assert.deepEqual(
    filtered.tools.map((t) => t.name),
    ["ocaml", "velociraptor"],
  );
  assert.equal(filtered.total_count, 2);

  const secondPage = await loadToolsPaginated(db, {
    search: "oc",
    limit: 1,
    page: 2,
  });
  assert.deepEqual(
    secondPage.tools.map((t) => t.name),
    ["ocaml"],
  );
  assert.equal(secondPage.total_pages, 3);
});

test("an explicit sort still ranks exact matches first", async () => {
  const db = fakeD1([
    { name: "ocaml", last_updated: "2026-09-01" },
    { name: "oc", last_updated: "2020-01-01" },
    { name: "velociraptor", last_updated: "2026-09-18" },
  ]);

  const byName = await loadToolsPaginated(db, { search: "oc", sort: "name" });
  assert.deepEqual(
    byName.tools.map((t) => t.name),
    ["oc", "ocaml", "velociraptor"],
  );

  const byUpdated = await loadToolsPaginated(db, {
    search: "oc",
    sort: "updated",
  });
  assert.deepEqual(
    byUpdated.tools.map((t) => t.name),
    ["oc", "ocaml", "velociraptor"],
  );
});
