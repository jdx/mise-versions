import { test } from "node:test";
import assert from "node:assert/strict";
import { forecastWeek, freshness } from "./stats-display";
test("forecast weeks start Monday across year boundaries", () => {
  assert.equal(forecastWeek("2026-01-01"), "Week of Dec 29, 2025");
  assert.equal(forecastWeek("2026-09-13"), "Week of Sep 7, 2026");
  assert.equal(forecastWeek("2026-09-14"), "Week of Sep 14, 2026");
});
test("freshness tolerates daily rollup delay but flags older observations", () => {
  const now = Date.parse("2026-09-10T19:00:00Z");
  assert.equal(freshness("2026-09-08", now), "Data through 2026-09-08");
  assert.equal(
    freshness("2026-09-07", now),
    "Data delayed · latest observation 2026-09-07 (3 days ago)",
  );
  assert.equal(freshness(undefined, now), "Data date unavailable");
});
