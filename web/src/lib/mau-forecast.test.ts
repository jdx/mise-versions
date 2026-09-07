/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import {
  FORECAST_WINDOW_DAYS,
  forecastNextMillion,
  formatForecastRelative,
  formatMillionLabel,
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

test("linear window projects a constant climb to 1M", () => {
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
  assert.equal(forecast.windowDays, FORECAST_WINDOW_DAYS);
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

test("projects the post-Quattro climb near the end of September 2026", () => {
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
  assert.ok(forecast.hitDate <= "2026-09-24");
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
