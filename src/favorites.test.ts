/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  MAX_FAVORITES,
  addFavorite,
  ensureFavoritesSchema,
  listFavorites,
  removeFavorite,
} from "./favorites.js";

// Minimal D1 stand-in backed by real SQLite so SQL and bind order are exercised.
function fakeD1({ withTable = true } = {}) {
  const db = new DatabaseSync(":memory:");
  if (withTable) {
    db.exec(`
      CREATE TABLE favorites (
        user_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, tool)
      )
    `);
  }
  return {
    prepare(query: string) {
      return {
        run: async () => {
          const info = db.prepare(query).run();
          return { meta: { changes: Number(info.changes) } };
        },
        bind: (...params: unknown[]) => ({
          all: async () => ({
            results: db.prepare(query).all(...(params as never[])),
          }),
          first: async () =>
            db.prepare(query).all(...(params as never[]))[0] ?? null,
          run: async () => {
            const info = db.prepare(query).run(...(params as never[]));
            return { meta: { changes: Number(info.changes) } };
          },
        }),
      };
    },
  } as unknown as D1Database;
}

test("adds, lists newest first, and removes favorites", async () => {
  const db = fakeD1();
  assert.equal(await addFavorite(db, "octocat", "node"), "added");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await addFavorite(db, "octocat", "python"), "added");
  assert.deepEqual(await listFavorites(db, "octocat"), ["python", "node"]);

  await removeFavorite(db, "octocat", "python");
  assert.deepEqual(await listFavorites(db, "octocat"), ["node"]);
});

test("adding an existing favorite is idempotent", async () => {
  const db = fakeD1();
  assert.equal(await addFavorite(db, "octocat", "node"), "added");
  assert.equal(await addFavorite(db, "octocat", "node"), "exists");
  assert.deepEqual(await listFavorites(db, "octocat"), ["node"]);
});

test("favorites are scoped per user", async () => {
  const db = fakeD1();
  await addFavorite(db, "octocat", "node");
  await addFavorite(db, "hubot", "go");
  assert.deepEqual(await listFavorites(db, "octocat"), ["node"]);
  assert.deepEqual(await listFavorites(db, "hubot"), ["go"]);
});

test("enforces the per-user cap but still reports existing entries", async () => {
  const db = fakeD1();
  for (let i = 0; i < MAX_FAVORITES; i++) {
    assert.equal(await addFavorite(db, "octocat", `tool-${i}`), "added");
  }
  assert.equal(await addFavorite(db, "octocat", "one-too-many"), "limit");
  assert.equal(await addFavorite(db, "octocat", "tool-0"), "exists");
  assert.equal(await addFavorite(db, "hubot", "one-too-many"), "added");
});

test("creates the table on first use when the migration has not run yet", async () => {
  const db = fakeD1({ withTable: false });
  await assert.rejects(listFavorites(db, "octocat"));
  await ensureFavoritesSchema(db);
  assert.deepEqual(await listFavorites(db, "octocat"), []);
  assert.equal(await addFavorite(db, "octocat", "node"), "added");
});
