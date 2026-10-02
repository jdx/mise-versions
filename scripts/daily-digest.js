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

// One metric on the digest day next to the day before and the same weekday a
// week earlier (many of these swing with the day of the week). Missing data is
// null, never zero.
function metricRow(label, current, previous, weekAgo) {
  return {
    label,
    current: current ?? null,
    previous: previous ?? null,
    weekAgo: weekAgo ?? null,
  };
}

function seriesRow(label, rows, day) {
  const values = byDate(rows);
  return metricRow(
    label,
    values.get(day),
    values.get(dateStrAgo(day, 1)),
    values.get(dateStrAgo(day, 7)),
  );
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
  const gained = (date) => {
    const now = totals.get(date);
    const before = totals.get(dateStrAgo(date, 1));
    return now !== undefined && before !== undefined && now >= before
      ? now - before
      : undefined;
  };
  return metricRow(
    "mise release downloads",
    gained(day),
    gained(dateStrAgo(day, 1)),
    gained(dateStrAgo(day, 7)),
  );
}

// Stars gained across every tracked project, from adjacent daily snapshots.
function starsRow(projects, day) {
  const gained = (date) => {
    let total;
    for (const p of projects) {
      const stars = byDate(
        p.history
          .filter((h) => h.stars > 0)
          .map((h) => ({ date: h.date, value: h.stars })),
      );
      const now = stars.get(date);
      const before = stars.get(dateStrAgo(date, 1));
      if (now !== undefined && before !== undefined)
        total = (total ?? 0) + (now - before);
    }
    return total;
  };
  return metricRow(
    "Stars gained",
    gained(day),
    gained(dateStrAgo(day, 1)),
    gained(dateStrAgo(day, 7)),
  );
}

// The headline table: every metric against the day before.
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

// Whether the per-tool rows cover the days being compared. Every day needs a
// daily total, and each day's tool rows should add up to about the same share
// of it as on a typical day in the 14-day window: rows for tools the rollup
// could not map are skipped, so the share is rarely 100% but is stable, while a
// partly written day falls well below it. A day with no downloads has no tool
// rows at all and is complete. Only problems on the `focus` dates (default: the
// whole window) are reported, so an old bad day cannot hide today's movers.
export function toolCoverage(toolDaily, totals, day, focus = null) {
  const problems = [];
  const report = (date, message) => {
    if (!focus || focus.includes(date)) problems.push(message);
  };
  const totalByDate = new Map(totals.map((r) => [r.date, r.value]));
  const toolByDate = new Map(toolDaily.map((r) => [r.date, r.value]));
  const ratios = [];
  for (let i = 0; i < 14; i++) {
    const date = dateStrAgo(day, i);
    const total = totalByDate.get(date);
    if (total === undefined) {
      report(date, `${date} has no daily total`);
    } else if (total === 0 && toolByDate.get(date) > 0) {
      // A re-refresh does not delete tool rows it no longer writes, so rows
      // left behind on a zero day are stale and would inflate the movers.
      report(date, `${date} has stale tool rows`);
    } else if (total > 0 && !toolByDate.has(date)) {
      // Never judged against the median: if most days lack rows the median is
      // zero and would let every one of them through.
      report(date, `${date} is missing tool rows`);
    } else if (total > 0) {
      ratios.push({ date, ratio: toolByDate.get(date) / total });
    }
  }
  const sorted = ratios.map((r) => r.ratio).sort((a, b) => a - b);
  // Upper quartile rather than the median: partly written days sit below the
  // true share, so a median would drift down with them when they are common.
  const typical = sorted.length
    ? sorted[Math.floor((sorted.length - 1) * 0.75)]
    : 0;
  for (const { date, ratio } of ratios) {
    if (ratio < typical * MIN_TOOL_COVERAGE)
      report(date, `${date} has a partial set of tool rows`);
  }
  return { complete: problems.length === 0, problems };
}

// Biggest absolute day-over-day movers among tools with real volume.
export function moversSection(rows, limit = 5) {
  const movers = rows
    .filter(
      (r) =>
        r.today >= MIN_MOVER_DOWNLOADS || r.yesterday >= MIN_MOVER_DOWNLOADS,
    )
    .map((r) => ({ ...r, change: r.today - r.yesterday }));
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
export function projectsSection(projects, day, limit = 8) {
  const gains = [];
  const milestones = [];
  for (const p of projects) {
    const history = p.history.filter((h) => h.stars > 0);
    // A milestone belongs to exactly one digest day: the one whose snapshot
    // crossed it, compared with the snapshot for the day before. Using the
    // latest snapshot instead would repeat it when that snapshot is dated
    // after the digest day and then becomes the digest day on the next run.
    const current = history.find((h) => h.date === day);
    const previous = history.find((h) => h.date === dateStrAgo(day, 1));
    if (!current || !previous) continue;
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
  // Quiet projects add rows but no information: keep everything that moved,
  // and fill up to the limit only when little did.
  const moved = gains.filter((g) => g.change !== 0);
  return {
    gains: (moved.length ? moved : gains).slice(0, limit),
    milestones,
  };
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

function changeText(row) {
  if (row.current === null) return `${row.label}: no data`;
  let text = `${row.label}: ${fmt(row.current)}`;
  if (row.previous !== null) {
    const change = pct(row.current, row.previous);
    text += `, ${signed(row.current - row.previous)}${change === "n/a" ? "" : ` (${change})`} vs yesterday`;
  }
  if (row.weekAgo !== null && pct(row.current, row.weekAgo) !== "n/a")
    text += `, ${pct(row.current, row.weekAgo)} vs same day last week`;
  return text;
}

function moverText(r) {
  return `${r.name}: ${fmt(r.today)} (${signed(r.change)}${r.yesterday > 0 ? `, ${pct(r.today, r.yesterday)}` : ", new"})`;
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
  section(`Changes since ${dateStrAgo(day, 1)}`, changes.map(changeText));
  const trendLines = trends
    .filter((t) => t.points.some((p) => p.value !== null))
    .map((t) => {
      const latest = t.points.at(-1).value;
      return `${t.label.padEnd(14)} ${sparkline(t.points)} ${latest === null ? "no data" : fmt(latest)}`;
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
  const change =
    row.current !== null && row.previous !== null
      ? pctChange(row.current, row.previous)
      : null;
  const delta =
    row.current !== null && row.previous !== null
      ? row.current - row.previous
      : null;
  return {
    label: row.label,
    lead: row.current === null ? undefined : fmt(row.current),
    value:
      change === null
        ? delta === null || delta === 0
          ? 0
          : Math.sign(delta) * MAX_BAR_PERCENT
        : change,
    text:
      delta === null
        ? "no comparison"
        : `${signed(delta)}${change === null ? "" : ` (${pct(row.current, row.previous)})`}`,
    sub:
      row.current !== null &&
      row.weekAgo !== null &&
      pct(row.current, row.weekAgo) !== "n/a"
        ? `${pct(row.current, row.weekAgo)} vs same day last week`
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
    heading(`Changes since ${dateStrAgo(day, 1)}`, `bars: % vs the day before`),
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
      lead: fmt(r.today),
      value: r.change,
      text: `${signed(r.change)}${r.yesterday > 0 ? ` (${pct(r.today, r.yesterday)})` : " new"}`,
    }),
  );
  if (moverItems.length)
    parts.push(
      heading("Tool download movers", "vs the day before"),
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
    downloads?.current != null && downloads.previous != null
      ? pct(downloads.current, downloads.previous)
      : "n/a";
  // Milestone text comes from project names, so keep control characters out of
  // the subject line.
  const subject = [
    `mise daily digest ${day}`,
    downloadsChange !== "n/a" && `downloads ${downloadsChange}`,
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
  const yesterday = dateStrAgo(day, 1);
  const coverageStart = dateStrAgo(day, 13);

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
      [coverageStart, day],
    ),
    queryD1(
      config,
      `SELECT t.name AS name,
         COALESCE(SUM(CASE WHEN s.date = ? THEN s.downloads END), 0) AS today,
         COALESCE(SUM(CASE WHEN s.date = ? THEN s.downloads END), 0) AS yesterday
       FROM daily_tool_stats s JOIN tools t ON t.id = s.tool_id
       WHERE s.date IN (?, ?)
       GROUP BY t.name`,
      [day, yesterday, day, yesterday],
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
  // The movers compare two days of per-tool rows, which a partial rollup
  // refresh can leave incomplete even when the aggregate tables are current.
  const coverage = toolCoverage(data.toolDaily, data.downloads, day, [
    day,
    dateStrAgo(day, 1),
  ]);
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
