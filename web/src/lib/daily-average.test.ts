import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sevenDayAverage,
  nextActivityMilestone,
  forecastDailyAverage,
} from "./daily-average";
import { forecastNextMillion } from "./mau-forecast";
import { releaseDays } from "./release-timeline";
test("average requires seven consecutive valid dates and retains zero days", () => {
  const points = Array.from({ length: 8 }, (_, i) => ({
    date: `2026-09-0${i + 1}`,
    value: i * 10,
  }));
  const result = sevenDayAverage(points);
  assert.equal(result[5].value, null);
  assert.equal(result[6].value, 30);
  assert.equal(result[7].value, 40);
  assert.equal(
    sevenDayAverage(points.filter((_, i) => i !== 3)).at(-1)?.value,
    null,
  );
  assert.equal(
    sevenDayAverage(points.map((p) => ({ ...p, value: 0 }))).at(-1)?.value,
    0,
  );
});
test("milestones choose the next useful level for both downloads and DAU", () => {
  assert.equal(nextActivityMilestone(350000), 500000);
  assert.equal(nextActivityMilestone(75000), 100000);
  assert.equal(nextActivityMilestone(250000), 500000);
  const values = Array.from({ length: 60 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    value: 100000 + i * 1000,
  }));
  const forecast = forecastDailyAverage(values);
  assert.equal(forecast?.target, 250000);
  assert.equal(forecast?.daysAway, 91);
  assert.equal(
    forecastDailyAverage(values.map((p) => ({ ...p, value: 100000 }))),
    null,
  );
  assert.equal(
    forecastDailyAverage([...values, { date: "2026-03-02", value: null }]),
    null,
  );
});
test("timeline groups release days chronologically and counts invalid dates", () => {
  const result = releaseDays([
    { version: "1", created_at: "2026-01-01" },
    { version: "2", created_at: "2026-01-01" },
    { version: "3", created_at: "2026-03-02" },
    { version: "4", created_at: "invalid" },
  ]);
  assert.deepEqual(
    result.days.map((d) => [d.date, d.releases.length]),
    [
      ["2026-01-01", 2],
      ["2026-03-02", 1],
    ],
  );
  assert.equal(result.undated, 1);
});

test("timeline labels stable major versions and 0.x minor introductions only", () => {
  const result = releaseDays([
    { version: "0.2.1", created_at: "2026-02-02" },
    { version: "0.2.0", created_at: "2026-02-01" },
    { version: "v1.0.0", created_at: "2026-03-01" },
    { version: "1.1.0", created_at: "2026-03-02" },
    { version: "2.0.0-rc.1", created_at: "2026-04-01" },
    { version: "sdk/go/v2.0.0", created_at: "2026-04-02" },
  ]);
  assert.deepEqual(
    result.days.map((d) => d.milestones),
    [["0.2"], [], ["1"], [], [], []],
  );
});

test("seven-day smoothing removes weekly MAU swings while preserving growth", () => {
  const points = Array.from({ length: 42 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10),
    value: 500000 + i * 1000 + [0, 7000, 14000, 7000, 0, -14000, -14000][i % 7],
  }));
  const averages = sevenDayAverage(points);
  for (let i = 6; i < points.length; i++) {
    assert.equal(averages[i].value, 500000 + (i - 3) * 1000);
  }
  assert.equal(points.at(-1)?.value, 527000);
  assert.equal(averages.at(-1)?.value, 538000);
  const forecast = forecastNextMillion(
    averages
      .filter((p): p is { date: string; value: number } => p.value !== null)
      .map((p) => ({ date: p.date, mau: p.value })),
  );
  assert.equal(forecast?.dailySlope, 1000);
  assert.equal(forecast?.daysAway, 462);
});
