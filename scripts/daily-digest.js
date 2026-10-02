#!/usr/bin/env node
/**
 * Email a daily digest of what changed in the most important mise stats since
 * the day before.
 *
 * Reads rollups straight from Cloudflare D1 (like the other *-direct.js
 * scripts) plus the committed project snapshots under web/src/data, then sends
 * one email through Resend. Pass --dry-run to print the email instead.
 *
 * The HTML charts are plain tables and inline-styled divs rather than images or
 * SVG, so they render in every mail client and need no chart service.
 */

import { readFile } from "node:fs/promises";
import { dateStrAgo, lastCompleteUtcDate } from "./lib/rollup-dates.js";
import { fetchWithRetry } from "./lib/fetch-with-retry.js";

const DEFAULT_ANALYTICS_DB_ID = "21a8b89a-c2cc-4a8a-9805-b4bcfcd4f6c8";
const DEFAULT_FROM = "mise-tools@en.dev";
const DEFAULT_TO = "mise-tools@mise.jdx.dev";
const STAR_MILESTONES = [
  100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000,
];
const MIN_MOVER_DOWNLOADS = 100;
const TREND_DAYS = 14;
// Percent-change bars are clipped here so one tiny, spiky metric (a handful of
// stars gained) cannot flatten every other bar in the chart.
const MAX_BAR_PERCENT = 50;
// A day's tool rows must reach this fraction of the typical tool-to-total
// ratio; below it the day lost tool rows to a partial refresh.
const MIN_TOOL_COVERAGE = 0.9;

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const signed = (n) => `${n >= 0 ? "+" : "−"}${fmt(Math.abs(n))}`;
const pctChange = (current, previous) =>
  previous > 0 ? ((current - previous) / previous) * 100 : null;
const pct = (current, previous) => {
  const change = pctChange(current, previous);
  if (change === null) return "n/a";
  return `${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(1)}%`;
};
const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

const byDate = (rows) => new Map(rows.map((r) => [r.date, r.value]));

const WEEK = 7;

// Average of the 7 days ending at `end`. Null unless every one of them has a
// value, so a gap cannot pass for a quiet week.
function weekAverage(valueOn, end) {
  let total = 0;
  for (let i = 0; i < WEEK; i++) {
    const value = valueOn(dateStrAgo(end, i));
    if (value === undefined) return null;
    total += value;
  }
  return total / WEEK;
}

// One metric on the digest day next to the day before, and its trailing 7-day
// average next to the 7 days before that. Daily numbers swing with the day of
// the week (weekends are always down), so the averages are the like-for-like
// comparison. `valueOn(date)` is the metric's value for a date, or undefined
// when unknown; missing data is null here, never zero.
function metricRow(label, valueOn, day) {
  return {
    label,
    current: valueOn(day) ?? null,
    previous: valueOn(dateStrAgo(day, 1)) ?? null,
    avg: weekAverage(valueOn, day),
    priorAvg: weekAverage(valueOn, dateStrAgo(day, WEEK)),
  };
}

function seriesRow(label, rows, day) {
  const values = byDate(rows);
  return metricRow(label, (date) => values.get(date), day);
}

// Release downloads are cumulative snapshots, so a day's number is the
// difference of two adjacent days; a decrease is a counter correction and has
// no daily value.
function releaseRow(project, day) {
  const totals = byDate(
    (project?.downloads ?? []).map((d) => ({
      date: d.date,
      value: d.downloads,
    })),
  );
  return metricRow(
    "mise release downloads",
    (date) => {
      const now = totals.get(date);
      const before = totals.get(dateStrAgo(date, 1));
      return now !== undefined && before !== undefined && now >= before
        ? now - before
        : undefined;
    },
    day,
  );
}

// Stars gained across every tracked project, from adjacent daily snapshots. A
// total that leaves a project out would understate it, so one missing snapshot
// makes the day unavailable (digestFromData warns about the project).
function starsRow(projects, day) {
  const snapshots = projects.map((p) =>
    byDate(
      p.history
        .filter((h) => h.stars > 0)
        .map((h) => ({ date: h.date, value: h.stars })),
    ),
  );
  return metricRow(
    "Stars gained",
    (date) => {
      let total;
      for (const stars of snapshots) {
        const now = stars.get(date);
        const before = stars.get(dateStrAgo(date, 1));
        if (now === undefined || before === undefined) return undefined;
        total = (total ?? 0) + (now - before);
      }
      return total;
    },
    day,
  );
}

// The headline table: every metric's 7-day average against the week before,
// plus the day against the day before.
export function changesSection({ mau, dau, downloads, projects }, day) {
  return [
    seriesRow("MAU", mau, day),
    seriesRow("DAU", dau, day),
    seriesRow("Tool downloads", downloads, day),
    releaseRow(
      projects.find((p) => p.name === "mise"),
      day,
    ),
    starsRow(projects, day),
  ];
}

// The last `days` days ending at `day`, oldest first; a day without a row is a
// gap rather than a zero.
export function trendSeries(rows, day, days = TREND_DAYS) {
  const values = byDate(rows);
  return Array.from({ length: days }, (_, i) => {
    const date = dateStrAgo(day, days - 1 - i);
    return { date, value: values.get(date) ?? null };
  });
}

// Whether the per-tool rows cover both weeks being compared. Every day needs a
// daily total, and each day's tool rows should add up to about the same share
// of it as on a typical day in the 14-day window: rows for tools the rollup
// could not map are skipped, so the share is rarely 100% but is stable, while a
// partly written day falls well below it. A day with no downloads has no tool
// rows at all and is complete.
export function toolCoverage(toolDaily, totals, day) {
  const problems = [];
  const totalByDate = new Map(totals.map((r) => [r.date, r.value]));
  const toolByDate = new Map(toolDaily.map((r) => [r.date, r.value]));
  const ratios = [];
  for (let i = 0; i < 14; i++) {
    const date = dateStrAgo(day, i);
    const total = totalByDate.get(date);
    if (total === undefined) {
      problems.push(`${date} has no daily total`);
    } else if (total === 0 && toolByDate.get(date) > 0) {
      // A re-refresh does not delete tool rows it no longer writes, so rows
      // left behind on a zero day are stale and would inflate the movers.
      problems.push(`${date} has stale tool rows`);
    } else if (total > 0 && !toolByDate.has(date)) {
      // Never judged against the median: if most days lack rows the median is
      // zero and would let every one of them through.
      problems.push(`${date} is missing tool rows`);
    } else if (total > 0) {
      ratios.push({ date, ratio: toolByDate.get(date) / total });
    }
  }
  const sorted = ratios.map((r) => r.ratio).sort((a, b) => a - b);
  // A high quantile rather than the median: partly written days sit below the
  // true share, so a median would drift down with them when they are common.
  // The 90th percentile still finds the true share while at least a tenth of
  // the window is complete; fewer than that and nothing can be judged anyway.
  const typical = sorted.length
    ? sorted[Math.floor((sorted.length - 1) * 0.9)]
    : 0;
  for (const { date, ratio } of ratios) {
    if (ratio < typical * MIN_TOOL_COVERAGE)
      problems.push(`${date} has a partial set of tool rows`);
  }
  return { complete: problems.length === 0, problems };
}

// Biggest absolute movers among tools with real volume, comparing the average
// downloads per day over the last 7 days with the 7 days before. Rows carry the
// two weeks' totals.
export function moversSection(rows, limit = 5) {
  const movers = rows
    .map((r) => ({
      name: r.name,
      avg: r.this_week / WEEK,
      priorAvg: r.last_week / WEEK,
    }))
    .filter(
      (r) => r.avg >= MIN_MOVER_DOWNLOADS || r.priorAvg >= MIN_MOVER_DOWNLOADS,
    )
    .map((r) => ({ ...r, change: r.avg - r.priorAvg }));
  return {
    up: movers
      .filter((r) => r.change > 0)
      .sort((a, b) => b.change - a.change)
      .slice(0, limit),
    down: movers
      .filter((r) => r.change < 0)
      .sort((a, b) => a.change - b.change)
      .slice(0, limit),
  };
}

// Stars gained per project on the digest day, and any star milestone crossed.
// Every tracked project is listed, including quiet ones; projects missing the
// snapshot for either day are reported in `missing` instead of silently dropped.
export function projectsSection(projects, day) {
  const gains = [];
  const missing = [];
  const milestones = [];
  for (const p of projects) {
    const history = p.history.filter((h) => h.stars > 0);
    // A milestone belongs to exactly one digest day: the one whose snapshot
    // crossed it, compared with the snapshot for the day before. Using the
    // latest snapshot instead would repeat it when that snapshot is dated
    // after the digest day and then becomes the digest day on the next run.
    const current = history.find((h) => h.date === day);
    const previous = history.find((h) => h.date === dateStrAgo(day, 1));
    if (!current || !previous) {
      missing.push(p.name);
      continue;
    }
    for (const target of STAR_MILESTONES) {
      if (previous.stars < target && current.stars >= target)
        milestones.push(
          `${p.name} reached ${target.toLocaleString("en-US")} stars`,
        );
    }
    gains.push({
      name: p.name,
      stars: current.stars,
      change: current.stars - previous.stars,
    });
  }
  gains.sort((a, b) => b.change - a.change || b.stars - a.stars);
  return { gains, missing, milestones };
}

// A short note when mise itself shipped recently.
export function releaseNote(release, now = Date.now()) {
  const published = release && Date.parse(release.published_at);
  if (published && now - published < 4 * 86400000)
    return `Latest release: mise ${release.tag_name} (${release.published_at.slice(0, 10)})`;
  return null;
}

// ---- Plain-text rendering ----

const SPARK = "▁▂▃▄▅▆▇█";

// Position of a value inside the series' own range, 0..1. A flat series sits
// mid-height rather than pinned to the floor.
function rangePosition(value, min, max) {
  return max > min ? (value - min) / (max - min) : 0.5;
}

function sparkline(points) {
  const values = points.map((p) => p.value).filter((v) => v !== null);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return points
    .map((p) =>
      p.value === null
        ? " "
        : SPARK[
            Math.round(rangePosition(p.value, min, max) * (SPARK.length - 1))
          ],
    )
    .join("");
}

const signedPct = (current, previous) => {
  const change = pct(current, previous);
  return change === "n/a" ? "" : ` (${change})`;
};

function changeText(row) {
  if (row.current === null) return `${row.label}: no data`;
  let text = `${row.label}: ${fmt(row.current)}`;
  if (row.avg !== null) text += `, 7d avg ${fmt(row.avg)}`;
  if (row.avg !== null && row.priorAvg !== null) {
    const change = pct(row.avg, row.priorAvg);
    text += `, ${change === "n/a" ? signed(row.avg - row.priorAvg) : change} vs the 7 days before`;
  } else {
    text += ", no 7d comparison";
  }
  if (row.previous !== null)
    text += `; day ${signed(row.current - row.previous)}${signedPct(row.current, row.previous)} vs yesterday`;
  return text;
}

function moverText(r) {
  return `${r.name}: ${fmt(r.avg)}/day (${signed(r.change)}${r.priorAvg > 0 ? `, ${pct(r.avg, r.priorAvg)}` : ", new"})`;
}

function renderText({
  day,
  warnings,
  milestones,
  changes,
  trends,
  movers,
  stars,
  note,
}) {
  const parts = [];
  const section = (title, lines) =>
    parts.push([title, ...lines.map((l) => `- ${l}`)].join("\n"));
  if (warnings.length) section("Data warnings", warnings);
  if (milestones.length) section("Milestones", milestones);
  if (note) parts.push(note);
  section(
    `Changes on ${day} (7-day averages vs the 7 days before)`,
    changes.map(changeText),
  );
  const shown = trends.filter((t) => t.points.some((p) => p.value !== null));
  const labelWidth = Math.max(...shown.map((t) => t.label.length));
  const trendLines = shown.map((t) => {
    const latest = t.points.at(-1).value;
    return `${t.label.padEnd(labelWidth)} ${sparkline(t.points)} ${latest === null ? "no data" : fmt(latest)}`;
  });
  if (trendLines.length) section(`Last ${TREND_DAYS} days`, trendLines);
  if (movers.up.length || movers.down.length) {
    section(
      "Tool download movers",
      [
        movers.up.length && `Up: ${movers.up.map(moverText).join("; ")}`,
        movers.down.length && `Down: ${movers.down.map(moverText).join("; ")}`,
      ].filter(Boolean),
    );
  }
  if (stars.length)
    section(
      "Stars gained",
      stars.map(
        (s) => `${s.name}: ${signed(s.change)} (${fmt(s.stars)} total)`,
      ),
    );
  return parts.join("\n\n");
}

// ---- HTML rendering ----

const COLOR = {
  text: "#1f2328",
  muted: "#59636e",
  axis: "#d1d9e0",
  up: "#1a7f37",
  down: "#cf222e",
  flat: "#8c959f",
  bar: "#54aeff",
  barLatest: "#0969da",
};
const signColor = (n) => (n > 0 ? COLOR.up : n < 0 ? COLOR.down : COLOR.flat);

const heading = (title, subtitle) =>
  `<h2 style="margin:28px 0 8px;font-size:16px;color:${COLOR.text}">${escapeHtml(title)}${subtitle ? ` <span style="font-weight:400;font-size:12px;color:${COLOR.muted}">${escapeHtml(subtitle)}</span>` : ""}</h2>`;

const bullets = (items) =>
  `<ul style="margin:0;padding-left:20px;font-size:14px;color:${COLOR.text}">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;

// A horizontal bar growing right (or left, when negative) from a centre axis.
// With nothing negative the axis moves to the left edge so the bars use the
// full width.
function bar(value, scale, oneSided) {
  const fill = (v) =>
    value === null || value === 0 || !(v * value > 0)
      ? ""
      : `<div style="height:10px;width:${Math.max(Math.min(Math.abs(value) / scale, 1) * 100, 2).toFixed(1)}%;background:${signColor(value)};border-radius:2px;${v < 0 ? "margin-left:auto" : ""}"></div>`;
  const cell = (inner, extra = "") =>
    `<td width="${oneSided ? 100 : 50}%" style="padding:0;${extra}">${inner}</td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed"><tr>${
    oneSided
      ? cell(fill(1), `border-left:1px solid ${COLOR.axis}`)
      : cell(fill(-1), `border-right:1px solid ${COLOR.axis}`) + cell(fill(1))
  }</tr></table>`;
}

// One chart of labelled bars: label, optional lead value, the bar, then text.
function barChart(items, scale) {
  const oneSided = items.every((i) => !(i.value < 0));
  const hasLead = items.some((i) => i.lead !== undefined);
  const rows = items
    .map(
      (i) => `<tr>
<td style="padding:5px 10px 5px 0;white-space:nowrap">${escapeHtml(i.label)}</td>
${hasLead ? `<td align="right" style="padding:5px 10px;white-space:nowrap;font-weight:600">${escapeHtml(i.lead ?? "—")}</td>` : ""}
<td style="padding:5px 0;width:40%">${bar(i.value, scale, oneSided)}</td>
<td style="padding:5px 0 5px 10px;white-space:nowrap;color:${signColor(i.value)}">${escapeHtml(i.text)}${i.sub ? `<div style="font-size:11px;color:${COLOR.muted}">${escapeHtml(i.sub)}</div>` : ""}</td>
</tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:${COLOR.text}">${rows}</table>`;
}

function changeItem(row) {
  const hasWeeks = row.avg !== null && row.priorAvg !== null;
  const change = hasWeeks ? pctChange(row.avg, row.priorAvg) : null;
  const delta = hasWeeks ? row.avg - row.priorAvg : null;
  return {
    label: row.label,
    lead: row.current === null ? undefined : fmt(row.current),
    // A week that grew from nothing has no percentage; clip it to a full bar.
    value:
      change === null
        ? delta === null || delta === 0
          ? 0
          : Math.sign(delta) * MAX_BAR_PERCENT
        : change,
    text: hasWeeks
      ? `${signed(delta)}/day${change === null ? "" : ` (${pct(row.avg, row.priorAvg)})`}`
      : "no 7d comparison",
    sub:
      row.current !== null && row.previous !== null
        ? `day ${signed(row.current - row.previous)}${signedPct(row.current, row.previous)} vs yesterday`
        : undefined,
  };
}

// Several metrics as small column strips sharing one date axis. Each strip is
// scaled to its own range, so metrics of very different size sit in one chart.
function trendChart(trends) {
  const height = 44;
  const strip = (points) => {
    const values = points.map((p) => p.value).filter((v) => v !== null);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const cells = points
      .map((p, i) => {
        const latest = i === points.length - 1;
        const px =
          p.value === null
            ? 2
            : Math.round(4 + rangePosition(p.value, min, max) * (height - 4));
        const color =
          p.value === null ? COLOR.axis : latest ? COLOR.barLatest : COLOR.bar;
        return `<td valign="bottom" style="padding:0 1px;height:${height}px"><div title="${escapeHtml(p.date)}: ${p.value === null ? "no data" : fmt(p.value)}" style="height:${px}px;background:${color};border-radius:2px 2px 0 0"></div></td>`;
      })
      .join("");
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed"><tr>${cells}</tr></table>`;
  };
  const rows = trends
    .filter((t) => t.points.some((p) => p.value !== null))
    .map((t) => {
      const values = t.points.map((p) => p.value).filter((v) => v !== null);
      return `<tr>
<td style="padding:6px 10px 6px 0;white-space:nowrap;vertical-align:bottom;font-size:13px">${escapeHtml(t.label)}<div style="font-size:11px;color:${COLOR.muted}">${fmt(Math.min(...values))}–${fmt(Math.max(...values))}</div></td>
<td style="padding:6px 0;width:70%">${strip(t.points)}</td>
</tr>`;
    });
  if (!rows.length) return "";
  const first = trends[0].points[0].date;
  const last = trends[0].points.at(-1).date;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="color:${COLOR.text}">${rows.join("")}
<tr><td></td><td style="font-size:11px;color:${COLOR.muted}"><span>${escapeHtml(first)}</span><span style="float:right">${escapeHtml(last)}</span></td></tr></table>`;
}

function renderHtml({
  day,
  warnings,
  milestones,
  changes,
  trends,
  movers,
  stars,
  note,
}) {
  const parts = [];
  if (warnings.length) parts.push(heading("Data warnings"), bullets(warnings));
  if (milestones.length) parts.push(heading("Milestones"), bullets(milestones));
  if (note)
    parts.push(
      `<p style="margin:16px 0 0;font-size:14px">${escapeHtml(note)}</p>`,
    );
  parts.push(
    heading(`Changes on ${day}`, "bars: 7-day average vs the 7 days before"),
    barChart(changes.map(changeItem), MAX_BAR_PERCENT),
  );
  const trend = trendChart(trends);
  if (trend)
    parts.push(
      heading(`Last ${TREND_DAYS} days`, "each row on its own scale"),
      trend,
    );
  const moverItems = [...movers.up, ...movers.down.slice().reverse()].map(
    (r) => ({
      label: r.name,
      lead: fmt(r.avg),
      value: r.change,
      text: `${signed(r.change)}/day${r.priorAvg > 0 ? ` (${pct(r.avg, r.priorAvg)})` : " new"}`,
    }),
  );
  if (moverItems.length)
    parts.push(
      heading(
        "Tool download movers",
        "7-day average per day vs the 7 days before",
      ),
      barChart(
        moverItems,
        Math.max(...moverItems.map((i) => Math.abs(i.value))),
      ),
    );
  if (stars.length)
    parts.push(
      heading("Stars gained"),
      barChart(
        stars.map((s) => ({
          label: s.name,
          lead: fmt(s.stars),
          value: s.change,
          text: signed(s.change),
        })),
        Math.max(1, ...stars.map((s) => Math.abs(s.change))),
      ),
    );
  return parts.join("");
}

export function buildDigest({
  day,
  warnings,
  milestones,
  changes,
  trends,
  movers = { up: [], down: [] },
  stars = [],
  note = null,
}) {
  const downloads = changes.find((c) => c.label === "Tool downloads");
  const downloadsChange =
    downloads?.avg != null && downloads.priorAvg != null
      ? pct(downloads.avg, downloads.priorAvg)
      : "n/a";
  // Milestone text comes from project names, so keep control characters out of
  // the subject line.
  const subject = [
    `mise daily digest ${day}`,
    downloadsChange !== "n/a" && `downloads ${downloadsChange} (7d avg)`,
    milestones[0],
  ]
    .filter(Boolean)
    .join(" · ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  const model = {
    day,
    warnings,
    milestones,
    changes,
    trends,
    movers,
    stars,
    note,
  };
  const footer = "https://mise-tools.jdx.dev/stats";
  return {
    subject,
    // Stable per day so a retried send cannot deliver the digest twice.
    idempotencyKey: `mise-daily-digest-${day}`,
    text: `${renderText(model)}\n\n${footer}\n`,
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:640px;background:#ffffff;color:${COLOR.text};padding:8px 16px">${renderHtml(model)}<p style="margin-top:24px"><a href="${footer}">${footer}</a></p></div>`,
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function queryD1(config, sql, params = []) {
  const response = await fetchWithRetry(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    },
  );
  const data = await response.json();
  const first = Array.isArray(data.result) ? data.result[0] : data.result;
  if (!data.success || !first?.success)
    throw new Error(`D1 query failed: ${JSON.stringify(data.errors ?? data)}`);
  return first.results ?? [];
}

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

// mise-events.json only keeps the first stable release of each month, so ask
// GitHub for the real latest one. The release line is optional: a failure here
// should not stop the rest of the digest from going out.
async function latestMiseRelease() {
  try {
    const headers = { Accept: "application/vnd.github+json" };
    if (process.env.GH_TOKEN)
      headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
    const response = await fetchWithRetry(
      "https://api.github.com/repos/jdx/mise/releases/latest",
      { headers },
    );
    return await response.json();
  } catch (error) {
    console.warn(`Could not fetch the latest mise release: ${error.message}`);
    return null;
  }
}

async function collect() {
  const config = {
    accountId: requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
    token: requiredEnv("CLOUDFLARE_API_TOKEN"),
    databaseId: process.env.ANALYTICS_DB_ID || DEFAULT_ANALYTICS_DB_ID,
  };
  const day = lastCompleteUtcDate();
  const since = dateStrAgo(day, 35);
  const weekStart = dateStrAgo(day, WEEK - 1);
  const priorStart = dateStrAgo(day, 2 * WEEK - 1);
  const priorEnd = dateStrAgo(day, WEEK);

  const [mau, dau, downloads, toolDaily, movers] = await Promise.all([
    queryD1(
      config,
      "SELECT date, mau AS value FROM daily_mau_stats WHERE date >= ? AND date <= ?",
      [since, day],
    ),
    queryD1(
      config,
      "SELECT date, unique_users AS value FROM daily_combined_stats WHERE date >= ? AND date <= ?",
      [since, day],
    ),
    queryD1(
      config,
      "SELECT date, total_downloads AS value FROM daily_stats WHERE date >= ? AND date <= ?",
      [since, day],
    ),
    queryD1(
      config,
      `SELECT date, SUM(downloads) AS value FROM daily_tool_stats
       WHERE date BETWEEN ? AND ? GROUP BY date`,
      [priorStart, day],
    ),
    queryD1(
      config,
      `SELECT t.name AS name,
         COALESCE(SUM(CASE WHEN s.date BETWEEN ? AND ? THEN s.downloads END), 0) AS this_week,
         COALESCE(SUM(CASE WHEN s.date BETWEEN ? AND ? THEN s.downloads END), 0) AS last_week
       FROM daily_tool_stats s JOIN tools t ON t.id = s.tool_id
       WHERE s.date BETWEEN ? AND ?
       GROUP BY t.name`,
      [weekStart, day, priorStart, priorEnd, priorStart, day],
    ),
  ]);
  const [projects, release] = await Promise.all([
    readJson("../web/src/data/projects.json"),
    latestMiseRelease(),
  ]);
  return {
    day,
    mau,
    dau,
    downloads,
    toolDaily,
    movers,
    projects: projects.projects,
    release,
  };
}

export function digestFromData(data, now = Date.now()) {
  const { day } = data;
  const projects = projectsSection(data.projects, day);
  const warnings = [];
  for (const [label, rows] of [
    ["MAU", data.mau],
    ["DAU", data.dau],
    ["Tool downloads", data.downloads],
  ]) {
    const latest = rows
      .map((r) => r.date)
      .sort()
      .at(-1);
    if (latest !== day)
      warnings.push(
        `${label} rollup is stale (latest ${latest ?? "none"}, expected ${day})`,
      );
  }
  // The movers compare two weeks of per-tool rows, which a partial rollup
  // refresh can leave incomplete even when the aggregate tables are current.
  const coverage = toolCoverage(data.toolDaily, data.downloads, day);
  const toolsCurrent = coverage.complete;
  if (!toolsCurrent)
    warnings.push(
      `Per-tool rollup is incomplete (${coverage.problems.slice(0, 3).join("; ")}${coverage.problems.length > 3 ? `; +${coverage.problems.length - 3} more` : ""}); tool movers omitted`,
    );
  const projectsLatest = data.projects
    .map((p) => p.history.at(-1)?.date)
    .filter(Boolean)
    .sort()
    .at(-1);
  if (projects.missing.length)
    warnings.push(
      `Star snapshots missing for ${projects.missing.join(", ")} on ${day} or ${dateStrAgo(day, 1)}; they are left out of the star figures`,
    );
  if (!projectsLatest || projectsLatest < day)
    warnings.push(
      `Project snapshot is stale (latest ${projectsLatest ?? "none"}, expected ${day}); star figures and milestones may be out of date`,
    );
  return buildDigest({
    day,
    warnings,
    milestones: projects.milestones,
    changes: changesSection(data, day),
    trends: [
      { label: "MAU", points: trendSeries(data.mau, day) },
      { label: "DAU", points: trendSeries(data.dau, day) },
      { label: "Tool downloads", points: trendSeries(data.downloads, day) },
    ],
    movers: toolsCurrent ? moversSection(data.movers) : undefined,
    stars: projects.gains,
    note: releaseNote(data.release, now),
  });
}

async function sendEmail({ subject, text, html, idempotencyKey }) {
  const response = await fetchWithRetry("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      from: process.env.DIGEST_FROM || DEFAULT_FROM,
      to: process.env.DIGEST_TO || DEFAULT_TO,
      subject,
      text,
      html,
    }),
  });
  const body = await response.json();
  console.log(`Sent digest email ${body.id ?? "(no id)"}`);
}

async function main() {
  const digest = digestFromData(await collect());
  if (process.argv.includes("--dry-run")) {
    console.log(`Subject: ${digest.subject}\n\n${digest.text}`);
    return;
  }
  await sendEmail(digest);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
