import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStarCsv,
  parseMiseDownloadsCsv,
  downloadChange,
  forecastStarCrossover,
} from "./mise-growth";

test("downloads accept the fetched_at column mise-analytics appends", () => {
  const csv =
    "date,repo_name,release_downloads,fetched_at\n2026-08-01,mise,0,\n2026-08-31,hk,900,2026-08-31T08:15:00Z\n2026-08-31,mise,110,2026-08-31T08:15:00Z";
  assert.deepEqual(parseMiseDownloadsCsv(csv), [
    { date: "2026-08-01", downloads: 0 },
    { date: "2026-08-31", downloads: 110, fetchedAt: "2026-08-31T08:15:00Z" },
  ]);
});
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

test("daily downloads scale each increase by the real time between snapshots", async () => {
  const { dailyDownloads, parseMiseDownloadsCsv } = await import("./mise-growth");
  // 36h gap then 12h gap: both are really 100/day, not 150 then 50.
  assert.deepEqual(
    dailyDownloads([
      { date: "2026-10-07", downloads: 0, fetchedAt: "2026-10-07T08:00:00Z" },
      { date: "2026-10-08", downloads: 150, fetchedAt: "2026-10-08T20:00:00Z" },
      { date: "2026-10-09", downloads: 200, fetchedAt: "2026-10-09T08:00:00Z" },
    ]),
    [
      { date: "2026-10-07", value: null },
      { date: "2026-10-08", value: 100 },
      { date: "2026-10-09", value: 100 },
    ],
  );
  // Rows without a timestamp are assumed to be the 08:15 UTC cron, so they stay 24h apart.
  assert.equal(
    dailyDownloads([
      { date: "2026-10-07", downloads: 0 },
      { date: "2026-10-08", downloads: 80 },
    ])[1].value,
    80,
  );
  // An unusable timestamp falls back to the cron assumption; the parser drops it.
  const points = parseMiseDownloadsCsv(
    "date,repo_name,release_downloads,fetched_at\n2026-10-07,mise,0,\n2026-10-08,mise,80,not-a-time\n2026-10-09,mise,160,2026-10-09T08:15:00Z",
  );
  assert.deepEqual(points.map((p) => p.fetchedAt), [undefined, undefined, "2026-10-09T08:15:00Z"]);
  assert.deepEqual(dailyDownloads(points).map((v) => v.value), [null, 80, 80]);
});

test("star history keeps mise’s earliest observations rather than imposing a recent cutoff", () => {
  const points = parseStarCsv(
    "date,mise_stars,brew_stars\n2022-12-01,0,33000\n2023-01-27,35,33306\n2026-09-07,33566,49455",
  );
  assert.equal(points[0].date, "2023-01-27");
  assert.equal(points.length, 2);
});
