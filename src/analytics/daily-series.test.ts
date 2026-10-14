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

test("prefers Logpush audience rows and keeps older days", async () => {
  const { mergeAudienceRows } = await import("./daily-series.js");
  const merged = mergeAudienceRows(
    {
      dau: [
        { date: "2026-10-01", dau: 7000 },
        { date: "2026-10-02", dau: 7100 },
      ],
      mau: [
        { date: "2026-10-01", mau: 50000 },
        { date: "2026-10-02", mau: 51000 },
        { date: "2026-10-03", mau: 52000 },
      ],
    },
    {
      dau: [{ date: "2026-10-02", dau: 30000 }],
      mau: [
        // partial window below the old count: not yet trustworthy
        { date: "2026-10-01", mau: 30000, days_covered: 1 },
        // partial window that already exceeds it
        { date: "2026-10-02", mau: 60000, days_covered: 2 },
        // complete window is always used
        { date: "2026-10-03", mau: 40000, days_covered: 30 },
        // partial window with no older row for that date: not used
        { date: "2026-10-04", mau: 90000, days_covered: 4 },
        { date: "2026-10-05", mau: 95000, days_covered: 30 },
      ],
    },
  );
  assert.deepEqual(Object.fromEntries(merged.dau), {
    "2026-10-01": 7000,
    "2026-10-02": 30000,
  });
  assert.deepEqual(Object.fromEntries(merged.mau), {
    "2026-10-01": 50000,
    "2026-10-02": 60000,
    "2026-10-03": 40000,
    "2026-10-05": 95000,
  });
});

test("once Logpush has taken over, older rows never fill its gaps", async () => {
  const { mergeAudienceRows } = await import("./daily-series.js");
  const merged = mergeAudienceRows(
    {
      dau: [
        { date: "2026-10-01", dau: 7000 },
        { date: "2026-10-02", dau: 7100 },
        { date: "2026-10-03", dau: 7200 }, // Logpush job failed that day
      ],
      mau: [
        { date: "2026-11-01", mau: 50000 },
        { date: "2026-11-02", mau: 50500 },
        { date: "2026-11-03", mau: 51000 }, // Logpush lagging
      ],
    },
    {
      dau: [{ date: "2026-10-02", dau: 30000 }],
      mau: [
        { date: "2026-11-02", mau: 200000, days_covered: 30 },
        // after a skipped day, later windows are short a day but still used
        { date: "2026-11-04", mau: 198000, days_covered: 29 },
      ],
    },
    { dau: "2026-10-02", mau: "2026-11-02" },
  );
  assert.deepEqual(Object.fromEntries(merged.dau), {
    "2026-10-01": 7000,
    "2026-10-02": 30000,
  });
  assert.deepEqual(Object.fromEntries(merged.mau), {
    "2026-11-01": 50000,
    "2026-11-02": 200000,
    "2026-11-04": 198000,
  });
});

test("header MAU keeps the older number while Logpush is partial and ahead", async () => {
  const { currentMau } = await import("./daily-series.js");
  // refresh-mau lagged a day behind a partial Logpush window.
  assert.equal(
    currentMau({
      legacy: { date: "2026-10-02", mau: 51000 },
      logpush: { date: "2026-10-03", mau: 30000, days_covered: 3 },
    }),
    51000,
  );
  // a partial window that already beats the same day's older number
  assert.equal(
    currentMau({
      legacy: { date: "2026-10-03", mau: 51000 },
      logpush: { date: "2026-10-03", mau: 60000, days_covered: 3 },
    }),
    60000,
  );
  assert.equal(currentMau({}), 0);
});

test("header MAU follows Logpush after takeover, even short a day", async () => {
  const { currentMau } = await import("./daily-series.js");
  assert.equal(
    currentMau({
      legacy: { date: "2026-11-05", mau: 51000 },
      logpush: { date: "2026-11-05", mau: 198000, days_covered: 29 },
      logpushComplete: { date: "2026-11-02", mau: 200000, days_covered: 30 },
    }),
    198000,
  );
});

test("header MAU stays on the newest complete Logpush row when Logpush lags", async () => {
  const { currentMau } = await import("./daily-series.js");
  assert.equal(
    currentMau({
      legacy: { date: "2026-11-05", mau: 51000 },
      logpush: { date: "2026-11-03", mau: 200000, days_covered: 30 },
      logpushComplete: { date: "2026-11-03", mau: 200000, days_covered: 30 },
    }),
    200000,
  );
});
