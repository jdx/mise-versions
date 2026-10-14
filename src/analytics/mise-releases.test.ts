/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  getMiseReleaseDownloads,
  parseMiseReleaseDays,
} from "./mise-releases.js";

// D1 stand-in backed by real SQLite, with the tables from migrations.ts.
function fakeD1(
  coveredDays: string[],
  rows: [string, string, number, number][],
) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE mise_release_download_days (
      date TEXT PRIMARY KEY,
      binary_requests INTEGER NOT NULL,
      other_requests INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE mise_release_daily_downloads (
      date TEXT NOT NULL,
      version TEXT NOT NULL,
      binary_requests INTEGER NOT NULL,
      other_requests INTEGER NOT NULL,
      PRIMARY KEY (date, version)
    );
  `);
  for (const date of coveredDays) {
    db.prepare(
      "INSERT INTO mise_release_download_days VALUES (?, 0, 0, 'now')",
    ).run(date);
  }
  for (const row of rows) {
    db.prepare(
      "INSERT INTO mise_release_daily_downloads VALUES (?, ?, ?, ?)",
    ).run(...row);
  }
  let queries = 0;
  const d1 = {
    prepare(query: string) {
      return {
        bind: (...params: unknown[]) => ({
          all: async () => {
            queries++;
            return {
              results: db.prepare(query).all(...(params as never[])),
            };
          },
        }),
      };
    },
  } as unknown as D1Database;
  return { d1, queries: () => queries };
}

test("parses ?days= as an integer from 1 to 35", () => {
  assert.equal(parseMiseReleaseDays(null), 30);
  assert.equal(parseMiseReleaseDays("1"), 1);
  assert.equal(parseMiseReleaseDays("35"), 35);
  for (const bad of ["", "0", "36", "-1", "1.5", "30abc", "1e1", " 30"]) {
    assert.equal(parseMiseReleaseDays(bad), null, bad);
  }
});

test("sums the most recent covered days per version in one query", async () => {
  const { d1, queries } = fakeD1(
    ["2026-10-15", "2026-10-16", "2026-10-18"],
    [
      // 10-14 was a partial day: rows exist but the day is not covered
      ["2026-10-14", "2026.10.8", 1000, 1000],
      ["2026-10-15", "2026.10.8", 5, 1],
      ["2026-10-15", "2026.9.0", 2, 0],
      ["2026-10-16", "2026.10.8", 7, 0],
      // 10-17 failed part way: not covered
      ["2026-10-17", "2026.10.8", 1000, 0],
      ["2026-10-18", "2026.10.8", 1, 2],
      ["2026-10-18", "2025.1.0", 0, 3],
    ],
  );
  assert.deepEqual(await getMiseReleaseDownloads(d1, 30), {
    days: 30,
    covered_days: 3,
    first_covered_date: "2026-10-15",
    last_covered_date: "2026-10-18",
    versions: {
      "2025.1.0": { binary: 0, other: 3 },
      "2026.10.8": { binary: 13, other: 3 },
      "2026.9.0": { binary: 2, other: 0 },
    },
  });
  assert.equal(queries(), 1);

  assert.deepEqual(await getMiseReleaseDownloads(d1, 2), {
    days: 2,
    covered_days: 2,
    first_covered_date: "2026-10-16",
    last_covered_date: "2026-10-18",
    versions: {
      "2025.1.0": { binary: 0, other: 3 },
      "2026.10.8": { binary: 8, other: 2 },
    },
  });
});

test("reports covered days with no downloads, and no coverage at all", async () => {
  assert.deepEqual(
    await getMiseReleaseDownloads(fakeD1(["2026-10-15"], []).d1, 30),
    {
      days: 30,
      covered_days: 1,
      first_covered_date: "2026-10-15",
      last_covered_date: "2026-10-15",
      versions: {},
    },
  );
  assert.deepEqual(await getMiseReleaseDownloads(fakeD1([], []).d1, 30), {
    days: 30,
    covered_days: 0,
    first_covered_date: null,
    last_covered_date: null,
    versions: {},
  });
});
