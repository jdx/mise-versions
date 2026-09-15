import { test } from "node:test";
import assert from "node:assert/strict";
import { trimPendingRollups } from "./daily-series.js";

const series = ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"].map(
  (date) => ({ date }),
);
const dates = (rolledUp: string[]) =>
  trimPendingRollups(series, (date) => rolledUp.includes(date)).map(
    (p) => p.date,
  );

test("drops days that are not rolled up yet from the end of the series", () => {
  assert.deepEqual(dates(series.map((p) => p.date)), [
    "2026-09-10",
    "2026-09-11",
    "2026-09-12",
    "2026-09-13",
  ]);
  assert.deepEqual(dates(["2026-09-10", "2026-09-11", "2026-09-12"]), [
    "2026-09-10",
    "2026-09-11",
    "2026-09-12",
  ]);
  assert.deepEqual(dates(["2026-09-10", "2026-09-11"]), [
    "2026-09-10",
    "2026-09-11",
  ]);
  assert.deepEqual(dates([]), []);
});

test("keeps interior gaps so a real outage stays visible", () => {
  assert.deepEqual(dates(["2026-09-10", "2026-09-12", "2026-09-13"]), [
    "2026-09-10",
    "2026-09-11",
    "2026-09-12",
    "2026-09-13",
  ]);
});

test("a day is only rolled up once both DAU and MAU are written", () => {
  const dau = new Set(["2026-09-10", "2026-09-11", "2026-09-12"]);
  // maintenance writes MAU first, so 09-13 has MAU but not yet DAU
  const mau = new Set(["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"]);
  assert.deepEqual(
    trimPendingRollups(series, (date) => dau.has(date) && mau.has(date)).map(
      (p) => p.date,
    ),
    ["2026-09-10", "2026-09-11", "2026-09-12"],
  );
});
