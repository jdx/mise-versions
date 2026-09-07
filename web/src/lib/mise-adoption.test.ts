import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdoptionCsv, starChange } from "./mise-adoption";
const header = "date,brew_rank,brew_installs,brew_pct,github_stars\n";
test("adoption parsing preserves missing metrics and genuine zeroes", () => {
  const points = parseAdoptionCsv(
    header + "2026-08-01,,,,100\r\n2026-08-31,2,0,0,150",
  );
  assert.equal(points[0].brewRank, null);
  assert.equal(points[1].brewInstalls, 0);
  assert.equal(starChange(points, 30), 50);
  assert.equal(starChange(points, 29), null);
});
test("CSV rejects schema drift and malformed observations; dates sort chronologically", () => {
  assert.throws(() => parseAdoptionCsv("unexpected\n1,2,3"));
  const points = parseAdoptionCsv(
    header +
      "2026-08-02,1,10,2,50\n2026-02-30,1,10,2,50\n2026-08-01,1,10,2,49\n2026-08-03,1,10,2,NaN",
  );
  assert.deepEqual(
    points.map((p) => p.date),
    ["2026-08-01", "2026-08-02"],
  );
});
