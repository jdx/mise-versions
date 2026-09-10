import { test } from "node:test";
import assert from "node:assert/strict";
import { weeklyMauGains, backendShares } from "./audience-growth";
const date = (i: number) =>
  new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
test("weekly gains use complete Sunday windows and retain negative changes", () => {
  const points = Array.from({ length: 35 }, (_, i) => ({
    date: date(i),
    mau: 100000 - i * 1000,
  }));
  const gains = weeklyMauGains(points).filter((p) => p.value !== null);
  assert(gains.length > 0);
  assert(gains.every((p) => p.value === -7000));
  assert(
    weeklyMauGains(points.filter((_, i) => i !== 26)).some(
      (p) => p.date === date(29) && p.value === null,
    ),
  );
});
test("backend shares use weekly volume, include other, and gap on missing days", () => {
  const rows = Array.from({ length: 14 }, (_, i) =>
    Array.from({ length: 7 }, (_, b) => ({
      date: date(i),
      backend: `b${b}`,
      downloads: b + 1,
    })),
  ).flat();
  const series = backendShares(rows);
  assert.equal(series.length, 6);
  assert(series.some((s) => s.name === "Other"));
  assert(
    Math.abs(series.reduce((n, s) => n + s.points.at(-1)!.value!, 0) - 100) <
      1e-10,
  );
  const gap = backendShares(rows.filter((r) => r.date !== date(10)));
  assert(gap.every((s) => s.points.at(-1)!.value === null));
});
