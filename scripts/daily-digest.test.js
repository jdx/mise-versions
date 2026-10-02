import { test } from "node:test";
import assert from "node:assert/strict";
import { dateStrAgo } from "./lib/rollup-dates.js";
import {
  changesSection,
  trendSeries,
  moversSection,
  projectsSection,
  releaseNote,
  digestFromData,
  buildDigest,
  toolCoverage,
} from "./daily-digest.js";

const NOW = Date.parse("2026-10-01T06:00:00Z");

const series = (day, values) =>
  values.map((value, i) => ({
    date: dateStrAgo(day, values.length - 1 - i),
    value,
  }));

test("changes compare the day with yesterday and the same day last week", () => {
  const day = "2026-09-30";
  const rows = changesSection(
    {
      mau: [
        { date: "2026-09-30", value: 1100 },
        { date: "2026-09-29", value: 1000 },
      ],
      dau: [
        { date: "2026-09-30", value: 220 },
        { date: "2026-09-29", value: 200 },
        { date: "2026-09-23", value: 200 },
      ],
      downloads: [],
      projects: [],
    },
    day,
  );
  assert.deepEqual(rows[0], {
    label: "MAU",
    current: 1100,
    previous: 1000,
    weekAgo: null,
  });
  assert.equal(rows[1].weekAgo, 200);
  // A missing day is null, never an invented zero.
  assert.equal(rows[2].current, null);
});

test("release downloads and stars are daily differences of adjacent snapshots", () => {
  const day = "2026-09-30";
  const projects = [
    {
      name: "mise",
      downloads: [
        { date: "2026-09-28", downloads: 100 },
        { date: "2026-09-29", downloads: 150 },
        { date: "2026-09-30", downloads: 230 },
      ],
      history: [
        { date: "2026-09-28", stars: 10 },
        { date: "2026-09-29", stars: 12 },
        { date: "2026-09-30", stars: 17 },
      ],
    },
    {
      name: "other",
      history: [
        { date: "2026-09-29", stars: 5 },
        { date: "2026-09-30", stars: 6 },
      ],
    },
  ];
  const [, , , release, stars] = changesSection(
    { mau: [], dau: [], downloads: [], projects },
    day,
  );
  assert.equal(release.current, 80);
  assert.equal(release.previous, 50);
  assert.equal(stars.current, 6);
  assert.equal(stars.previous, 2);
});

test("a counter decrease or gap leaves release downloads without a value", () => {
  const project = (downloads) => ({ name: "mise", downloads, history: [] });
  const release = (p) =>
    changesSection(
      { mau: [], dau: [], downloads: [], projects: [p] },
      "2026-09-30",
    )[3];
  assert.equal(
    release(
      project([
        { date: "2026-09-29", downloads: 200 },
        { date: "2026-09-30", downloads: 150 },
      ]),
    ).current,
    null,
  );
  assert.equal(
    release(
      project([
        { date: "2026-09-27", downloads: 10 },
        { date: "2026-09-30", downloads: 50 },
      ]),
    ).current,
    null,
  );
});

test("trend series keeps gaps as null and ends on the digest day", () => {
  const points = trendSeries(
    [
      { date: "2026-09-30", value: 3 },
      { date: "2026-09-28", value: 1 },
    ],
    "2026-09-30",
    4,
  );
  assert.deepEqual(
    points.map((p) => [p.date, p.value]),
    [
      ["2026-09-27", null],
      ["2026-09-28", 1],
      ["2026-09-29", null],
      ["2026-09-30", 3],
    ],
  );
});

test("movers compare the day with yesterday, ignore low volume, sort by change", () => {
  const { up, down } = moversSection([
    { name: "big", today: 1500, yesterday: 500 },
    { name: "tiny", today: 50, yesterday: 5 },
    { name: "drop", today: 100, yesterday: 900 },
  ]);
  assert.deepEqual(
    up.map((r) => [r.name, r.change]),
    [["big", 1000]],
  );
  assert.deepEqual(
    down.map((r) => [r.name, r.change]),
    [["drop", -800]],
  );
});

test("a star milestone crossed on the digest day is reported", () => {
  const history = [
    { date: "2026-09-29", stars: 999 },
    { date: "2026-09-30", stars: 1001 },
  ];
  const section = projectsSection([{ name: "demo", history }], "2026-09-30");
  assert.deepEqual(section.milestones, ["demo reached 1,000 stars"]);
  assert.deepEqual(section.gains, [{ name: "demo", stars: 1001, change: 2 }]);
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

test("a milestone is reported on exactly one digest day", () => {
  // The snapshot refresh already ran today, so history includes day + 1.
  const history = [
    { date: "2026-09-29", stars: 999 },
    { date: "2026-09-30", stars: 999 },
    { date: "2026-10-01", stars: 1001 },
  ];
  const project = { name: "demo", history };
  assert.deepEqual(projectsSection([project], "2026-09-30").milestones, []);
  assert.deepEqual(projectsSection([project], "2026-10-01").milestones, [
    "demo reached 1,000 stars",
  ]);
  // Next run after a missed refresh: same snapshot, a later digest day.
  assert.deepEqual(projectsSection([project], "2026-10-02").milestones, []);
});

test("a stale snapshot does not repeat a milestone it already announced", () => {
  const history = [
    { date: "2026-09-27", stars: 999 },
    { date: "2026-09-28", stars: 1001 },
  ];
  assert.deepEqual(
    projectsSection([{ name: "demo", history }], "2026-09-30").milestones,
    [],
  );
});

test("star gains list the projects that moved, biggest first", () => {
  const project = (name, from, to) => ({
    name,
    history: [
      { date: "2026-09-29", stars: from },
      { date: "2026-09-30", stars: to },
    ],
  });
  const { gains } = projectsSection(
    [project("quiet", 50, 50), project("a", 10, 12), project("b", 100, 110)],
    "2026-09-30",
  );
  assert.deepEqual(
    gains.map((g) => g.name),
    ["b", "a"],
  );
});

test("projects without yesterday's snapshot are left out of the gains", () => {
  const section = projectsSection(
    [{ name: "demo", history: [{ date: "2026-09-30", stars: 10 }] }],
    "2026-09-30",
  );
  assert.deepEqual(section.gains, []);
});

test("the latest release comes from the release record, not monthly markers", () => {
  const release = {
    tag_name: "v2026.10.1",
    published_at: "2026-09-30T12:00:00Z",
  };
  assert.equal(
    releaseNote(release, NOW),
    "Latest release: mise v2026.10.1 (2026-09-30)",
  );
  assert.equal(
    releaseNote({ ...release, published_at: "2026-09-01T12:00:00Z" }, NOW),
    null,
  );
  assert.equal(releaseNote(null, NOW), null);
});

const fullData = (overrides = {}) => {
  const day = "2026-09-30";
  const days = 35;
  return {
    day,
    mau: series(day, Array(days).fill(1000)),
    dau: series(day, Array(days).fill(200)),
    downloads: series(day, Array(days).fill(1000)),
    toolDaily: series(day, Array(14).fill(980)),
    movers: [{ name: "big", today: 1500, yesterday: 500 }],
    projects: [
      {
        name: "mise",
        history: [
          { date: "2026-09-29", stars: 100 },
          { date: "2026-09-30", stars: 103 },
        ],
        downloads: [],
      },
    ],
    release: null,
    ...overrides,
  };
};

test("the digest focuses on change since the day before", () => {
  const data = fullData();
  data.downloads = series(data.day, Array(34).fill(1000).concat([1100]));
  const digest = digestFromData(data, NOW);
  assert.equal(
    digest.subject,
    "mise daily digest 2026-09-30 · downloads +10.0%",
  );
  assert.match(digest.text, /Changes since 2026-09-29/);
  assert.match(
    digest.text,
    /Tool downloads: 1,100, \+100 \(\+10\.0%\) vs yesterday/,
  );
  assert.match(digest.text, /Up: big: 1,500 \(\+1,000, \+200\.0%\)/);
  assert.match(digest.text, /mise: \+3 \(103 total\)/);
  assert.doesNotMatch(digest.text, /Data warnings/);
  // One combined chart per topic rather than one chart per metric.
  assert.match(digest.html, /Changes since 2026-09-29/);
  assert.match(digest.html, /Last 14 days/);
  assert.match(digest.html, /Tool download movers/);
  assert.match(digest.html, /Stars gained/);
  assert.equal(digest.html.match(/<h2/g).length, 4);
});

test("stale rollups produce a warning in the email", () => {
  const digest = digestFromData(
    fullData({
      mau: [{ date: "2026-09-28", value: 1 }],
      dau: [],
      downloads: [],
      toolDaily: [{ date: "2026-09-30", value: 100 }],
      projects: [],
    }),
    NOW,
  );
  assert.match(digest.text, /Data warnings/);
  assert.match(digest.text, /MAU rollup is stale \(latest 2026-09-28/);
  assert.match(
    digest.text,
    /Per-tool rollup is incomplete \(2026-09-30 has no daily total/,
  );
  assert.match(digest.text, /Project snapshot is stale/);
  assert.doesNotMatch(digest.text, /Tool download movers/);
  assert.equal(digest.idempotencyKey, "mise-daily-digest-2026-09-30");
});

test("a bad day outside the comparison does not hide the movers", () => {
  const toolDaily = series("2026-09-30", Array(14).fill(980)).map((r) =>
    r.date === "2026-09-20" ? { ...r, value: 100 } : r,
  );
  const digest = digestFromData(fullData({ toolDaily }), NOW);
  assert.match(digest.text, /Tool download movers/);
  assert.doesNotMatch(digest.text, /Per-tool rollup is incomplete/);
});

test("missing data renders without NaN or undefined", () => {
  const digest = digestFromData(
    fullData({ mau: [], dau: [], downloads: [], toolDaily: [], movers: [] }),
    NOW,
  );
  for (const out of [digest.text, digest.html, digest.subject])
    assert.doesNotMatch(out, /NaN|undefined|Infinity/);
  assert.match(digest.text, /MAU: no data/);
});

test("html escapes names coming from data", () => {
  const digest = digestFromData(
    fullData({ movers: [{ name: "<b>x</b>", today: 900, yesterday: 100 }] }),
    NOW,
  );
  assert.doesNotMatch(digest.html, /<b>x<\/b>/);
  assert.match(digest.html, /&lt;b&gt;x&lt;\/b&gt;/);
});

const dayRows = (day, count, value) =>
  Array.from({ length: count }, (_, i) => ({
    date: dateStrAgo(day, i),
    value,
  }));

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
    changes: [],
    trends: [],
    warnings: [],
    milestones: ["evil\r\nBcc: x@example.com reached 100 stars"],
  });
  assert.doesNotMatch(digest.subject, /[\r\n]/);
});
