import { test } from "node:test";
import assert from "node:assert/strict";
import { weeklyMauGains } from "./audience-growth";
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
