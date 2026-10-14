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
  const { dailyDownloads, parseMiseDownloadsCsv } =
    await import("./mise-growth");
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
  assert.deepEqual(
    points.map((p) => p.fetchedAt),
    [undefined, undefined, "2026-10-09T08:15:00Z"],
  );
  assert.deepEqual(
    dailyDownloads(points).map((v) => v.value),
    [null, 80, 80],
  );
});

test("star history keeps mise’s earliest observations rather than imposing a recent cutoff", () => {
  const points = parseStarCsv(
    "date,mise_stars,brew_stars\n2022-12-01,0,33000\n2023-01-27,35,33306\n2026-09-07,33566,49455",
  );
  assert.equal(points[0].date, "2023-01-27");
  assert.equal(points.length, 2);
});

const day = (i: number) =>
  new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
// Cumulative GitHub snapshots taken at the same time every day, rising by
// `rate` per day from 2026-10-01.
const snapshots = (count: number, rate = 100) =>
  Array.from({ length: count }, (_, i) => ({
    date: day(i),
    downloads: 1000 + rate * i,
  }));

test("combined downloads keep GitHub alone before CDN counts start and need both after", async () => {
  const { combineDownloads } = await import("./mise-growth");
  const github = [
    { date: "2026-10-13", value: 100 },
    { date: "2026-10-14", value: 110 },
    { date: "2026-10-15", value: 120 },
    { date: "2026-10-16", value: null },
    { date: "2026-10-17", value: 130 },
    { date: "2026-10-18", value: 140 },
    { date: "2026-10-19", value: 150 },
  ];
  const cdn = [
    { date: "2026-10-15", downloads: 5 },
    { date: "2026-10-16", downloads: 6 },
    // 2026-10-17 was not fully covered
    { date: "2026-10-18", downloads: 0 },
  ];
  const { points, cdnStart } = combineDownloads(github, cdn);
  assert.equal(cdnStart, "2026-10-15");
  assert.deepEqual(points, [
    { date: "2026-10-13", value: 100, github: 100, cdn: null },
    { date: "2026-10-14", value: 110, github: 110, cdn: null },
    { date: "2026-10-15", value: 125, github: 120, cdn: 5 },
    { date: "2026-10-16", value: null, github: null, cdn: 6 },
    { date: "2026-10-17", value: null, github: 130, cdn: null },
    // a covered day with no downloads is a real zero
    { date: "2026-10-18", value: 140, github: 140, cdn: 0 },
    // 2026-10-19 is past the last CDN rollup, so it waits for it
  ]);
  assert.deepEqual(combineDownloads(github, []), {
    points: github.map((p) => ({ ...p, github: p.value, cdn: null })),
    cdnStart: null,
  });
});

test("combined 30-day change needs CDN counts for every day of the window", async () => {
  const { combinedDownloadChange, downloadChange } =
    await import("./mise-growth");
  const github = snapshots(40);
  assert.equal(downloadChange(github, 30, day(35)), 3000);
  assert.equal(downloadChange(github, 30, "2027-01-01"), null);
  const cdn = Array.from({ length: 30 }, (_, i) => ({
    date: day(6 + i),
    downloads: 10,
  }));
  assert.equal(combinedDownloadChange(github, cdn, 30, day(35)), 3300);
  assert.equal(combinedDownloadChange(github, cdn, 30, day(36)), null);
});

test("download summary adds CDN once it has a full week, and says GitHub alone before", async () => {
  const { miseDownloadSummary } = await import("./mise-growth");
  const github = snapshots(40);
  const noCdn = miseDownloadSummary(github, []);
  assert.equal(noCdn.combined, false);
  assert.equal(noCdn.average, 100);
  assert.equal(noCdn.date, day(39));
  assert.equal(noCdn.change30d, 3000);
  assert.equal(noCdn.combinedFrom, null);

  const cdn = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      date: day(30 + i),
      downloads: 20,
    }));
  const firstWeek = miseDownloadSummary(github, cdn(6));
  assert.equal(firstWeek.combined, false);
  assert.equal(firstWeek.average, 100);
  assert.equal(firstWeek.combinedFrom, day(36));

  const fullWeek = miseDownloadSummary(github, cdn(7));
  assert.equal(fullWeek.combined, true);
  assert.equal(fullWeek.date, day(36));
  assert.equal(fullWeek.average, 120);
  assert.equal(fullWeek.github, 100);
  assert.equal(fullWeek.cdn, 20);
  // CDN does not cover 30 days yet, so the 30-day change is GitHub's
  assert.equal(fullWeek.change30d, 3000);
  assert.equal(fullWeek.change30dSource, "github");
  assert.equal(fullWeek.points.at(-1)?.date, day(36));
});

test("after a complete combined week, a gap in either source keeps the last complete week instead of GitHub alone", async () => {
  const { miseDownloadSummary } = await import("./mise-growth");
  const cdn = (count: number, skip?: number) =>
    Array.from({ length: count }, (_, i) => ({
      date: day(20 + i),
      downloads: 20,
    })).filter((_, i) => i !== skip);

  // CDN missed its latest-but-one day (2026-10-29): the latest week has a
  // gap, so the headline stays on the week ending 2026-10-28.
  const cdnGap = miseDownloadSummary(snapshots(31), cdn(10, 8));
  assert.equal(cdnGap.combined, true);
  assert.equal(cdnGap.date, day(27));
  assert.equal(cdnGap.average, 120);
  assert.equal(cdnGap.github, 100);
  assert.equal(cdnGap.cdn, 20);

  // GitHub has no snapshot for 2026-10-28, so neither it nor 2026-10-29 has
  // a daily increase.
  const github = snapshots(31).filter((p) => p.date !== day(27));
  const githubGap = miseDownloadSummary(github, cdn(10));
  assert.equal(githubGap.combined, true);
  assert.equal(githubGap.date, day(26));
  assert.equal(githubGap.average, 120);

  // Gaps that never allowed a complete week: GitHub alone, without
  // promising a date that has already passed.
  const never = miseDownloadSummary(snapshots(31), cdn(10, 3));
  assert.equal(never.combined, false);
  assert.equal(never.combinedFrom, null);
});
