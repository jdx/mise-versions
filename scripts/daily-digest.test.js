import { test } from "node:test";
import assert from "node:assert/strict";
import {
  audienceSection,
  downloadsSection,
  moversSection,
  projectsSection,
  miseReleaseSection,
  digestFromData,
} from "./daily-digest.js";

const NOW = Date.parse("2026-10-01T06:00:00Z");

test("audience compares MAU against a week and a month earlier", () => {
  const section = audienceSection(
    [
      { date: "2026-09-30", value: 1100 },
      { date: "2026-09-23", value: 1000 },
      { date: "2026-08-31", value: 1200 },
    ],
    [
      { date: "2026-09-30", value: 220 },
      { date: "2026-09-23", value: 200 },
    ],
    "2026-09-30",
  );
  assert.equal(
    section.lines[0],
    "MAU 1,100 (+100 vs 7d ago) (−100 vs 30d ago)",
  );
  assert.equal(section.lines[1], "DAU 220 (+10.0% vs same day last week)");
});

test("audience reports a missing day instead of inventing a number", () => {
  const section = audienceSection([], [], "2026-09-30");
  assert.deepEqual(section.lines, ["No MAU recorded for 2026-09-30 yet."]);
});

test("downloads compare the last 7 days with the 7 before", () => {
  const rows = [];
  for (let i = 0; i < 14; i++) {
    const date = new Date(Date.parse("2026-09-30T00:00:00Z") - i * 86400000)
      .toISOString()
      .slice(0, 10);
    rows.push({ date, value: i < 7 ? 200 : 100 });
  }
  const section = downloadsSection(rows, "2026-09-30");
  assert.match(section.lines[1], /Last 7 days: 1,400 \(\+100\.0%/);
});

test("movers ignore low-volume tools and sort by absolute change", () => {
  const section = moversSection([
    { name: "big", this_week: 1000, last_week: 500 },
    { name: "tiny", this_week: 50, last_week: 5 },
    { name: "drop", this_week: 100, last_week: 900 },
  ]);
  assert.match(section.lines[0], /^Up: big: 1,000 \(\+500, \+100\.0%\)$/);
  assert.match(section.lines[1], /^Down: drop: 100 \(−800/);
  assert.doesNotMatch(section.lines.join(), /tiny/);
});

test("a star milestone crossed in the latest day is reported", () => {
  const history = [
    { date: "2026-09-29", stars: 999 },
    { date: "2026-09-30", stars: 1001 },
  ];
  const section = projectsSection([{ name: "demo", history }], NOW);
  assert.deepEqual(section.milestones, ["demo reached 1,000 stars"]);
});

test("old milestones are not repeated", () => {
  const history = [
    { date: "2026-08-01", stars: 999 },
    { date: "2026-08-02", stars: 1001 },
  ];
  assert.deepEqual(
    projectsSection([{ name: "demo", history }], NOW).milestones,
    [],
  );
});

test("release downloads need adjacent days", () => {
  const gap = miseReleaseSection(
    {
      downloads: [
        { date: "2026-09-27", downloads: 10 },
        { date: "2026-09-30", downloads: 50 },
      ],
    },
    [],
    NOW,
  );
  assert.deepEqual(gap.lines, []);
});

test("stale rollups produce a warning in the email", () => {
  const digest = digestFromData(
    {
      day: "2026-09-30",
      mau: [{ date: "2026-09-28", value: 1 }],
      dau: [],
      downloads: [],
      movers: [],
      projects: [],
      events: [],
    },
    NOW,
  );
  assert.match(digest.text, /Data warnings/);
  assert.match(digest.text, /MAU rollup is stale \(latest 2026-09-28/);
});
