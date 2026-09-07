import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStarCsv,
  parseMiseDownloadsCsv,
  downloadChange,
  forecastStarCrossover,
} from "./mise-growth";

test("downloads select mise alone, deduplicate snapshots and preserve real zeroes", () => {
  const csv =
    "date,repo_name,release_downloads\r\n2026-08-01,mise,0\r\n2026-08-31,hk,900\r\n2026-08-31,mise,100\r\n2026-08-31,mise,110\r\n2026-02-30,mise,9";
  const points = parseMiseDownloadsCsv(csv);
  assert.deepEqual(points, [
    { date: "2026-08-01", downloads: 0 },
    { date: "2026-08-31", downloads: 110 },
  ]);
  assert.equal(downloadChange(points, 30), 110);
  assert.equal(downloadChange(points, 7), null);
  assert.equal(
    downloadChange(
      [
        { date: "2026-08-01", downloads: 200 },
        { date: "2026-08-31", downloads: 110 },
      ],
      30,
    ),
    null,
  );
  assert.throws(() => parseMiseDownloadsCsv("date,repo,downloads"));
});
test("star parsing aligns both repositories by date and excludes unavailable history", () => {
  assert.deepEqual(
    parseStarCsv(
      "date,mise_stars,brew_stars,extra\n2026-08-02,10,20,0\n2026-08-01,0,20,0\n2026-08-03,11,,0",
    ),
    [{ date: "2026-08-02", mise: 10, homebrew: 20 }],
  );
  assert.throws(() => parseStarCsv("date,mise_stars"));
});
function history(miseRate = 100, brewRate = 20) {
  return Array.from({ length: 366 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
    mise: 10000 + miseRate * i,
    homebrew: 40000 + brewRate * i,
  }));
}
test("crossover projects Homebrew growth too, and strictly passes its moving target", () => {
  const result = forecastStarCrossover(history());
  assert.equal(result?.status, "forecast");
  if (result?.status !== "forecast") throw new Error("Missing forecast");
  assert.equal(result.daysAway, 11);
  assert.equal(result.misePace, 100);
  assert.equal(result.brewPace, 20);
  assert.equal(result.hitDate, "2026-01-12");
  assert.ok(
    result.stars > result.latest.homebrew + result.brewPace * result.daysAway,
  );
});
test("crossover handles ahead, non-closing, insufficient and distant histories", () => {
  assert.equal(forecastStarCrossover(history(200))?.status, "ahead");
  assert.equal(forecastStarCrossover(history(20, 20))?.status, "not-closing");
  assert.equal(forecastStarCrossover(history(21, 20))?.status, "distant");
  assert.equal(forecastStarCrossover(history().slice(-1)), null);
});

test("daily downloads use adjacent snapshots, preserving zeroes and leaving gaps for corrections", async () => {
  const { dailyDownloads } = await import("./mise-growth");
  assert.deepEqual(
    dailyDownloads([
      { date: "2026-09-01", downloads: 100 },
      { date: "2026-09-02", downloads: 150 },
      { date: "2026-09-03", downloads: 150 },
      { date: "2026-09-05", downloads: 250 },
      { date: "2026-09-06", downloads: 200 },
      { date: "2026-09-07", downloads: 225 },
    ]),
    [
      { date: "2026-09-01", value: null },
      { date: "2026-09-02", value: 50 },
      { date: "2026-09-03", value: 0 },
      { date: "2026-09-05", value: null },
      { date: "2026-09-06", value: null },
      { date: "2026-09-07", value: 25 },
    ],
  );
});
