import { test } from "node:test";
import assert from "node:assert/strict";
import { dateStrAgo } from "./lib/rollup-dates.js";
import {
  audienceSection,
  downloadsSection,
  moversSection,
  projectsSection,
  miseReleaseSection,
  digestFromData,
  buildDigest,
  toolCoverage,
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
  const section = projectsSection([{ name: "demo", history }], "2026-09-30");
  assert.deepEqual(section.milestones, ["demo reached 1,000 stars"]);
});

test("old milestones are not repeated", () => {
  const history = [
    { date: "2026-08-01", stars: 999 },
    { date: "2026-08-02", stars: 1001 },
  ];
  assert.deepEqual(
    projectsSection([{ name: "demo", history }], "2026-09-30").milestones,
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
    null,
    "2026-09-30",
    NOW,
  );
  assert.deepEqual(gap.lines, []);
});

test("release downloads are for the digest day, not today's partial snapshot", () => {
  const section = miseReleaseSection(
    {
      downloads: [
        { date: "2026-09-29", downloads: 100 },
        { date: "2026-09-30", downloads: 150 },
        { date: "2026-10-01", downloads: 160 },
      ],
    },
    null,
    "2026-09-30",
    NOW,
  );
  assert.deepEqual(section.lines, [
    "mise GitHub release downloads on 2026-09-30: 50",
  ]);
});

test("stale rollups produce a warning in the email", () => {
  const digest = digestFromData(
    {
      day: "2026-09-30",
      mau: [{ date: "2026-09-28", value: 1 }],
      dau: [],
      downloads: [],
      toolDaily: [{ date: "2026-09-30", value: 100 }],
      movers: [{ name: "big", this_week: 1000, last_week: 500 }],
      projects: [],
      release: null,
    },
    NOW,
  );
  assert.match(digest.text, /Data warnings/);
  assert.match(digest.text, /MAU rollup is stale \(latest 2026-09-28/);
  assert.match(
    digest.text,
    /Per-tool rollup is incomplete \(2026-09-30 has no daily total/,
  );
  assert.match(digest.text, /Project snapshot is stale/);
  assert.doesNotMatch(digest.text, /Tool movers \(7d/);
  assert.equal(digest.idempotencyKey, "mise-daily-digest-2026-09-30");
});

test("projects without a comparison point get no empty parentheses", () => {
  const section = projectsSection(
    [{ name: "demo", history: [{ date: "2026-09-30", stars: 10 }] }],
    "2026-09-30",
  );
  assert.deepEqual(section.lines, ["demo: 10 stars"]);
});

test("the latest release comes from the release record, not monthly markers", () => {
  const release = {
    tag_name: "v2026.10.1",
    published_at: "2026-09-30T12:00:00Z",
  };
  assert.deepEqual(miseReleaseSection(null, release, "2026-09-30", NOW).lines, [
    "Latest release: mise v2026.10.1 (2026-09-30)",
  ]);
  assert.deepEqual(
    miseReleaseSection(
      null,
      { ...release, published_at: "2026-09-01T12:00:00Z" },
      "2026-09-30",
      NOW,
    ).lines,
    [],
  );
});

const dayRows = (day, count, value) =>
  Array.from({ length: count }, (_, i) => ({
    date: dateStrAgo(day, i),
    value,
  }));

test("weekly download totals are withheld when a day is missing", () => {
  const rows = dayRows("2026-09-30", 14, 100).filter(
    (r) => r.date !== "2026-09-27",
  );
  const section = downloadsSection(rows, "2026-09-30");
  assert.equal(
    section.lines[1],
    "Weekly totals unavailable: 6/7 days recorded this week, 7/7 the week before",
  );
});

test("tool coverage flags a partly written day", () => {
  const totals = dayRows("2026-09-30", 14, 1000);
  assert.equal(
    toolCoverage(dayRows("2026-09-30", 14, 980), totals, "2026-09-30").complete,
    true,
  );
  const partial = dayRows("2026-09-30", 14, 980).map((r) =>
    r.date === "2026-09-28" ? { ...r, value: 300 } : r,
  );
  const result = toolCoverage(partial, totals, "2026-09-30");
  assert.equal(result.complete, false);
  assert.deepEqual(result.problems, [
    "2026-09-28 has a partial set of tool rows",
  ]);
});

test("tool coverage accepts a stable share of unmapped tools", () => {
  const totals = dayRows("2026-09-30", 14, 1000);
  assert.equal(
    toolCoverage(dayRows("2026-09-30", 14, 700), totals, "2026-09-30").complete,
    true,
  );
});

test("tool coverage flags partial days even when most of the window is partial", () => {
  const totals = dayRows("2026-09-30", 14, 1000);
  const tools = dayRows("2026-09-30", 14, 1000).map((r, i) =>
    i < 8 ? { ...r, value: 850 } : r,
  );
  const result = toolCoverage(tools, totals, "2026-09-30");
  assert.equal(result.complete, false);
  assert.equal(result.problems.length, 8);
});

test("a zero-download day has no tool rows and is still complete", () => {
  const totals = dayRows("2026-09-30", 14, 1000).map((r) =>
    r.date === "2026-09-25" ? { ...r, value: 0 } : r,
  );
  const tools = dayRows("2026-09-30", 14, 980).filter(
    (r) => r.date !== "2026-09-25",
  );
  assert.equal(toolCoverage(tools, totals, "2026-09-30").complete, true);
});

test("most days missing tool rows is not treated as typical", () => {
  const totals = dayRows("2026-09-30", 14, 1000);
  const result = toolCoverage(
    dayRows("2026-09-30", 2, 980),
    totals,
    "2026-09-30",
  );
  assert.equal(result.complete, false);
  assert.equal(result.problems.length, 12);
});

test("tool rows left on a zero-download day are flagged as stale", () => {
  const totals = dayRows("2026-09-30", 14, 1000).map((r) =>
    r.date === "2026-09-25" ? { ...r, value: 0 } : r,
  );
  assert.deepEqual(
    toolCoverage(dayRows("2026-09-30", 14, 980), totals, "2026-09-30").problems,
    ["2026-09-25 has stale tool rows"],
  );
});

test("a day with downloads but no tool rows is flagged", () => {
  const totals = dayRows("2026-09-30", 14, 1000);
  const tools = dayRows("2026-09-30", 14, 980).filter(
    (r) => r.date !== "2026-09-25",
  );
  assert.deepEqual(toolCoverage(tools, totals, "2026-09-30").problems, [
    "2026-09-25 is missing tool rows",
  ]);
});

test("control characters never reach the subject line", () => {
  const digest = buildDigest({
    day: "2026-09-30",
    sections: [],
    warnings: [],
    milestones: ["evil\r\nBcc: x@example.com reached 100 stars"],
  });
  assert.doesNotMatch(digest.subject, /[\r\n]/);
});
