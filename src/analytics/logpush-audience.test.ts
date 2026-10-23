/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getLogpushAudience, isPartialLogpushDay } from "./logpush-audience.js";

// D1 stand-in backed by real SQLite, with the tables from migrations.ts.
function fakeD1(
  dau: [string, number, string | null, string | null][],
  mau: [string, number, number][],
) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE logpush_daily_dau (
      date TEXT PRIMARY KEY,
      unique_users INTEGER NOT NULL,
      mise_requests INTEGER NOT NULL,
      ci_requests INTEGER NOT NULL,
      log_lines INTEGER NOT NULL,
      first_event_at TEXT,
      last_event_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE logpush_daily_mau (
      date TEXT PRIMARY KEY,
      mau INTEGER NOT NULL,
      days_covered INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  for (const [date, users, first, last] of dau) {
    db.prepare(
      "INSERT INTO logpush_daily_dau VALUES (?, ?, 0, 0, 0, ?, ?, 'now')",
    ).run(date, users, first, last);
  }
  for (const row of mau) {
    db.prepare("INSERT INTO logpush_daily_mau VALUES (?, ?, ?, 'now')").run(
      ...row,
    );
  }
  return {
    prepare(query: string) {
      return {
        bind: (...params: unknown[]) => ({
          all: async () => ({
            results: db.prepare(query).all(...(params as never[])),
          }),
        }),
      };
    },
  } as unknown as D1Database;
}

const full = (date: string) =>
  [`${date}T00:00:00.000Z`, `${date}T23:59:59.000Z`] as const;

test("flags days whose logs do not span the whole UTC day", () => {
  assert.equal(isPartialLogpushDay("2026-10-15", ...full("2026-10-15")), false);
  assert.equal(
    isPartialLogpushDay(
      "2026-10-14",
      "2026-10-14T14:52:54.000Z",
      "2026-10-14T23:59:59.000Z",
    ),
    true,
  );
  assert.equal(
    isPartialLogpushDay(
      "2026-10-15",
      "2026-10-15T00:00:00.000Z",
      "2026-10-15T20:00:00.000Z",
    ),
    true,
  );
  assert.equal(isPartialLogpushDay("2026-10-15", null, null), true);
});

test("reads daily DAU oldest first with the latest MAU row", async () => {
  const d1 = fakeD1(
    [
      ["2026-10-15", 435686, ...full("2026-10-15")],
      [
        "2026-10-14",
        248852,
        "2026-10-14T14:52:54.000Z",
        "2026-10-14T23:59:59.000Z",
      ],
      ["2026-10-16", 440000, ...full("2026-10-16")],
    ],
    [
      ["2026-10-14", 248852, 1],
      ["2026-10-15", 598230, 2],
    ],
  );
  assert.deepEqual(await getLogpushAudience(d1), {
    daily: [
      { date: "2026-10-14", dau: 248852, partial: true },
      { date: "2026-10-15", dau: 435686, partial: false },
      { date: "2026-10-16", dau: 440000, partial: false },
    ],
    mau: { date: "2026-10-15", mau: 598230, days_covered: 2 },
  });
  const recent = await getLogpushAudience(d1, 1);
  assert.deepEqual(
    recent?.daily.map((p) => p.date),
    ["2026-10-16"],
  );
  assert.equal(recent?.mau, null);
});

test("returns null before any day is rolled up", async () => {
  assert.equal(await getLogpushAudience(fakeD1([], [])), null);
});
