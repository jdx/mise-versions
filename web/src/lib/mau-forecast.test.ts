/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import {
  blendedDailyPace,
  forecastNextMillion,
  formatForecastRelative,
  formatMillionLabel,
  formatPaceLabel,
  nextMillion,
} from "./mau-forecast";

function series(
  start: string,
  values: number[],
  stepDays = 1,
): Array<{ date: string; mau: number }> {
  const origin = Date.parse(`${start}T00:00:00Z`);
  return values.map((mau, index) => ({
    date: new Date(origin + index * stepDays * 86_400_000)
      .toISOString()
      .slice(0, 10),
    mau,
  }));
}

test("next million is the first million above current MAU", () => {
  assert.equal(nextMillion(755_509), 1_000_000);
  assert.equal(nextMillion(999_999), 1_000_000);
  assert.equal(nextMillion(1_000_000), 2_000_000);
  assert.equal(nextMillion(1_500_000), 2_000_000);
  assert.equal(nextMillion(2_000_001), 3_000_000);
});

test("million labels stay compact", () => {
  assert.equal(formatMillionLabel(1_000_000), "1M");
  assert.equal(formatMillionLabel(2_000_000), "2M");
});

test("relative copy covers days, weeks, months, and years", () => {
  assert.equal(formatForecastRelative(0), "today");
  assert.equal(formatForecastRelative(1), "tomorrow");
  assert.equal(formatForecastRelative(16), "in 16 days");
  assert.equal(formatForecastRelative(21), "in 3 weeks");
  assert.equal(formatForecastRelative(90), "in 3 months");
  assert.equal(formatForecastRelative(800), "in 2.2 years");
});

test("pace labels name the windows that contributed", () => {
  assert.equal(formatPaceLabel([7]), "7-day rate");
  assert.equal(formatPaceLabel([7, 30]), "average of 7-day and 30-day rates");
  assert.equal(
    formatPaceLabel([7, 30, 365]),
    "average of 7-day, 30-day, and 365-day rates",
  );
});

test("blends 7-day, 30-day, and 365-day endpoint rates equally", () => {
  const points = [
    { date: "2025-12-31", mau: 335_000 },
    { date: "2026-12-01", mau: 400_000 },
    { date: "2026-12-24", mau: 560_000 },
    { date: "2026-12-31", mau: 700_000 },
  ];
  const pace = blendedDailyPace(points);
  assert.ok(pace);
  assert.deepEqual(pace.windows, [7, 30, 365]);
  assert.ok(Math.abs(pace.slope - (20_000 + 10_000 + 1_000) / 3) < 1e-6);
});

test("constant recent climb still hits 1M on that pace", () => {
  const points = series(
    "2026-08-17",
    Array.from({ length: 21 }, (_, i) => 460_000 + i * 14_000),
  );
  const forecast = forecastNextMillion(points);
  assert.ok(forecast);
  assert.equal(forecast.target, 1_000_000);
  assert.equal(forecast.targetLabel, "1M");
  assert.equal(forecast.hitDate, "2026-09-24");
  assert.equal(forecast.daysAway, 18);
  assert.deepEqual(forecast.windows, [7, 30]);
  assert.equal(forecast.showOnChart, true);
  assert.equal(forecast.showInText, true);
  assert.ok(Math.abs(forecast.dailySlope - 14_000) < 1e-6);
});

test("after 1M the same slope aims at 2M", () => {
  const points = series(
    "2026-10-01",
    Array.from({ length: 21 }, (_, i) => 1_050_000 + i * 10_000),
  );
  const forecast = forecastNextMillion(points);
  assert.ok(forecast);
  assert.equal(forecast.target, 2_000_000);
  assert.equal(forecast.targetLabel, "2M");
  assert.equal(forecast.showOnChart, true);
});

test("hides the chart line after 16 months but keeps page copy", () => {
  const points = series(
    "2026-01-01",
    Array.from({ length: 21 }, (_, i) => 100_000 + i * 1_000),
  );
  const forecast = forecastNextMillion(points);
  assert.ok(forecast);
  assert.equal(forecast.showOnChart, false);
  assert.equal(forecast.showInText, true);
  assert.ok(forecast.daysAway > 16 * 30);
});

test("omits forecasts more than 10 years out", () => {
  const points = series(
    "2026-01-01",
    Array.from({ length: 21 }, (_, i) => 100_000 + i * 20),
  );
  assert.equal(forecastNextMillion(points), null);
});

test("omits a forecast when MAU is not increasing", () => {
  const points = series(
    "2026-08-01",
    Array.from({ length: 21 }, (_, i) => 800_000 - i * 1_000),
  );
  assert.equal(forecastNextMillion(points), null);
});

test("long-run rate pulls a short spike later than a 7-day fit alone", () => {
  const slow = series(
    "2026-01-01",
    Array.from({ length: 359 }, (_, i) => 300_000 + i * 500),
  );
  const latestSlow = slow.at(-1)!;
  const fast = series(
    latestSlow.date,
    Array.from({ length: 8 }, (_, i) => latestSlow.mau + i * 20_000),
  );
  const points = [...slow.slice(0, -1), ...fast];
  const forecast = forecastNextMillion(points);
  assert.ok(forecast);
  assert.deepEqual(forecast.windows, [7, 30, 365]);

  const sevenDayOnly = (fast.at(-1)!.mau - fast[0]!.mau) / 7;
  assert.ok(forecast.dailySlope < sevenDayOnly);
  assert.ok(forecast.hitDate >= "2027-02-01");
});

test("projects the post-Quattro climb in late September 2026", () => {
  const points = [
    ["2026-08-17", 481_024],
    ["2026-08-18", 497_974],
    ["2026-08-19", 508_684],
    ["2026-08-20", 518_085],
    ["2026-08-21", 528_046],
    ["2026-08-22", 536_235],
    ["2026-08-23", 544_070],
    ["2026-08-24", 568_065],
    ["2026-08-25", 593_168],
    ["2026-08-26", 609_492],
    ["2026-08-27", 626_301],
    ["2026-08-28", 639_563],
    ["2026-08-29", 646_457],
    ["2026-08-30", 652_422],
    ["2026-08-31", 676_917],
    ["2026-09-01", 701_828],
    ["2026-09-02", 720_069],
    ["2026-09-03", 734_217],
    ["2026-09-04", 747_358],
    ["2026-09-05", 752_423],
    ["2026-09-06", 755_509],
  ].map(([date, mau]) => ({ date, mau: Number(mau) }));
  const forecast = forecastNextMillion(points);
  assert.ok(forecast);
  assert.equal(forecast.targetLabel, "1M");
  assert.equal(forecast.showOnChart, true);
  assert.ok(forecast.hitDate >= "2026-09-20");
  assert.ok(forecast.hitDate <= "2026-09-26");
});

test("needs enough recent points to fit", () => {
  assert.equal(
    forecastNextMillion([
      { date: "2026-09-01", mau: 700_000 },
      { date: "2026-09-02", mau: 720_000 },
    ]),
    null,
  );
});
