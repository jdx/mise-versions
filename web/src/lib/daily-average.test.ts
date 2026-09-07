import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sevenDayAverage,
  nextActivityMilestone,
  forecastDailyAverage,
} from "./daily-average";
import { releaseMonths } from "./release-timeline";
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
test("timeline preserves same-day releases, empty months, and invalid-date counts", () => {
  const result = releaseMonths([
    { version: "1", created_at: "2026-01-01" },
    { version: "2", created_at: "2026-01-01" },
    { version: "3", created_at: "2026-03-02" },
    { version: "4", created_at: "invalid" },
  ]);
  assert.deepEqual(
    result.months.map((m) => [m.month, m.releases.length]),
    [
      ["2026-01", 2],
      ["2026-02", 0],
      ["2026-03", 1],
    ],
  );
  assert.equal(result.undated, 1);
});
