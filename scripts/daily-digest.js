#!/usr/bin/env node
/**
 * Email a daily digest of the most important mise stats.
 *
 * Reads rollups straight from Cloudflare D1 (like the other *-direct.js
 * scripts) plus the committed project snapshots under web/src/data, then sends
 * one email through Resend. Pass --dry-run to print the email instead.
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
// A day's tool rows must reach this fraction of the typical tool-to-total
// ratio; below it the day lost tool rows to a partial refresh.
const MIN_TOOL_COVERAGE = 0.9;

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const signed = (n) => `${n >= 0 ? "+" : "−"}${fmt(Math.abs(n))}`;
const pct = (current, previous) => {
  if (!(previous > 0)) return "n/a";
  const change = ((current - previous) / previous) * 100;
  return `${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(1)}%`;
};
const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

function sumRange(rows, start, end) {
  return rows
    .filter((r) => r.date >= start && r.date <= end)
    .reduce((sum, r) => sum + r.value, 0);
}

// Audience: latest MAU/DAU against a week and a month earlier.
export function audienceSection(mauRows, dauRows, day) {
  const byDate = (rows) => new Map(rows.map((r) => [r.date, r.value]));
  const mau = byDate(mauRows);
  const dau = byDate(dauRows);
  const lines = [];
  const latestMau = mau.get(day);
  if (latestMau === undefined) {
    lines.push(`No MAU recorded for ${day} yet.`);
  } else {
    const week = mau.get(dateStrAgo(day, 7));
    const month = mau.get(dateStrAgo(day, 30));
    lines.push(
      `MAU ${fmt(latestMau)}` +
        (week !== undefined ? ` (${signed(latestMau - week)} vs 7d ago)` : "") +
        (month !== undefined
          ? ` (${signed(latestMau - month)} vs 30d ago)`
          : ""),
    );
  }
  const latestDau = dau.get(day);
  if (latestDau !== undefined) {
    const lastWeek = dau.get(dateStrAgo(day, 7));
    lines.push(
      `DAU ${fmt(latestDau)}` +
        (lastWeek !== undefined
          ? ` (${pct(latestDau, lastWeek)} vs same day last week)`
          : ""),
    );
  }
  return { title: "Audience", lines };
}

// Number of distinct days with a row in the inclusive range.
function daysRecorded(rows, start, end) {
  return new Set(
    rows.filter((r) => r.date >= start && r.date <= end).map((r) => r.date),
  ).size;
}

// Tool downloads through mise: the day itself plus 7d vs the prior 7d. A
// weekly total is only meaningful when every day in both windows was recorded.
export function downloadsSection(rows, day) {
  const yesterday = rows.find((r) => r.date === day)?.value;
  const weekStart = dateStrAgo(day, 6);
  const priorStart = dateStrAgo(day, 13);
  const priorEnd = dateStrAgo(day, 7);
  const lines = [];
  if (yesterday === undefined) {
    lines.push(`No tool downloads recorded for ${day} yet.`);
  } else {
    const sameDay = rows.find((r) => r.date === dateStrAgo(day, 7))?.value;
    lines.push(
      `${fmt(yesterday)} tool downloads on ${day}` +
        (sameDay ? ` (${pct(yesterday, sameDay)} vs same day last week)` : ""),
    );
  }
  const thisDays = daysRecorded(rows, weekStart, day);
  const priorDays = daysRecorded(rows, priorStart, priorEnd);
  if (thisDays === 7 && priorDays === 7) {
    const thisWeek = sumRange(rows, weekStart, day);
    const lastWeek = sumRange(rows, priorStart, priorEnd);
    lines.push(
      `Last 7 days: ${fmt(thisWeek)} (${pct(thisWeek, lastWeek)} vs the 7 days before)`,
    );
  } else {
    lines.push(
      `Weekly totals unavailable: ${thisDays}/7 days recorded this week, ${priorDays}/7 the week before`,
    );
  }
  return { title: "Tool downloads", lines };
}

// Whether the per-tool rows cover both comparison weeks completely. Every day
// needs a daily total, and each day's tool rows should add up to about the same
// share of it as on a typical day in the window: rows for tools the rollup
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
    } else if (total > 0 && !toolByDate.has(date)) {
      // Never judged against the median: if most days lack rows the median is
      // zero and would let every one of them through.
      problems.push(`${date} is missing tool rows`);
    } else if (total > 0) {
      ratios.push({ date, ratio: toolByDate.get(date) / total });
    }
  }
  const sorted = ratios.map((r) => r.ratio).sort((a, b) => a - b);
  const typical = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  for (const { date, ratio } of ratios) {
    if (ratio < typical * MIN_TOOL_COVERAGE)
      problems.push(`${date} has a partial set of tool rows`);
  }
  return { complete: problems.length === 0, problems };
}

// Biggest absolute week-over-week movers among tools with real volume.
export function moversSection(rows, limit = 5) {
  const movers = rows
    .filter(
      (r) =>
        r.this_week >= MIN_MOVER_DOWNLOADS ||
        r.last_week >= MIN_MOVER_DOWNLOADS,
    )
    .map((r) => ({ ...r, gain: r.this_week - r.last_week }));
  const describe = (r) =>
    `${r.name}: ${fmt(r.this_week)} (${signed(r.gain)}${r.last_week > 0 ? `, ${pct(r.this_week, r.last_week)}` : ", new"})`;
  const gainers = movers
    .filter((r) => r.gain > 0)
    .sort((a, b) => b.gain - a.gain)
    .slice(0, limit);
  const decliners = movers
    .filter((r) => r.gain < 0)
    .sort((a, b) => a.gain - b.gain)
    .slice(0, limit);
  const lines = [];
  if (gainers.length) lines.push("Up: " + gainers.map(describe).join("; "));
  if (decliners.length)
    lines.push("Down: " + decliners.map(describe).join("; "));
  if (!lines.length) lines.push("No tools moved meaningfully this week.");
  return { title: "Tool movers (7d vs previous 7d)", lines };
}

// Star growth per project, and any star milestone crossed in the last 2 days.
export function projectsSection(projects, day) {
  const lines = [];
  const milestones = [];
  const ranked = projects
    .map((p) => {
      const history = p.history.filter((h) => h.stars > 0);
      const latest = history.at(-1);
      if (!latest) return null;
      const at = (days) =>
        history.find((h) => h.date === dateStrAgo(latest.date, days))?.stars;
      const week = at(7);
      const month = at(30);
      const previous = history.at(-2);
      for (const target of STAR_MILESTONES) {
        if (
          previous &&
          previous.stars < target &&
          latest.stars >= target &&
          latest.date >= day
        )
          milestones.push(
            `${p.name} reached ${target.toLocaleString("en-US")} stars`,
          );
      }
      return {
        name: p.name,
        stars: latest.stars,
        week: week === undefined ? null : latest.stars - week,
        month: month === undefined ? null : latest.stars - month,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.week ?? -Infinity) - (a.week ?? -Infinity));
  for (const r of ranked.slice(0, 5)) {
    const changes = [
      r.week !== null && `${signed(r.week)} 7d`,
      r.month !== null && `${signed(r.month)} 30d`,
    ].filter(Boolean);
    lines.push(
      `${r.name}: ${fmt(r.stars)} stars${changes.length ? ` (${changes.join(", ")})` : ""}`,
    );
  }
  return {
    title: "Project stars",
    lines: lines.length ? lines : ["No project history available."],
    milestones,
  };
}

// Release downloads are cumulative snapshots, so the daily number is the
// difference of two adjacent days; anything else could be a counter correction.
export function miseReleaseSection(project, release, day, now = Date.now()) {
  const lines = [];
  const downloads = project?.downloads ?? [];
  const latest = downloads.find((d) => d.date === day);
  const previous = downloads.find((d) => d.date === dateStrAgo(day, 1));
  if (latest && previous && latest.downloads >= previous.downloads)
    lines.push(
      `mise GitHub release downloads on ${day}: ${fmt(latest.downloads - previous.downloads)}`,
    );
  const published = release && Date.parse(release.published_at);
  if (published && now - published < 4 * 86400000)
    lines.push(
      `Latest release: mise ${release.tag_name} (${release.published_at.slice(0, 10)})`,
    );
  return { title: "mise releases", lines };
}

export function buildDigest({ day, sections, milestones, warnings }) {
  // Milestone text comes from project names, so keep control characters out of
  // the subject line.
  const subject = (
    milestones.length
      ? `mise daily digest ${day} · ${milestones[0]}`
      : `mise daily digest ${day}`
  )
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  const textParts = [];
  const htmlParts = [];
  if (warnings.length) {
    textParts.push(
      ["Data warnings", ...warnings.map((w) => `- ${w}`)].join("\n"),
    );
    htmlParts.push(
      `<h2>Data warnings</h2><ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`,
    );
  }
  if (milestones.length) {
    textParts.push(
      ["Milestones", ...milestones.map((m) => `- ${m}`)].join("\n"),
    );
    htmlParts.push(
      `<h2>Milestones</h2><ul>${milestones.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul>`,
    );
  }
  for (const section of sections.filter((s) => s.lines.length)) {
    textParts.push(
      [section.title, ...section.lines.map((l) => `- ${l}`)].join("\n"),
    );
    htmlParts.push(
      `<h2>${escapeHtml(section.title)}</h2><ul>${section.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`,
    );
  }
  const footer = "https://mise-tools.jdx.dev/stats";
  return {
    subject,
    // Stable per day so a retried send cannot deliver the digest twice.
    idempotencyKey: `mise-daily-digest-${day}`,
    text: `${textParts.join("\n\n")}\n\n${footer}\n`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:640px">${htmlParts.join("")}<p><a href="${footer}">${footer}</a></p></div>`,
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
  const weekStart = dateStrAgo(day, 6);
  const priorStart = dateStrAgo(day, 13);
  const priorEnd = dateStrAgo(day, 7);

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
  const projects = projectsSection(data.projects, data.day);
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
    if (latest !== data.day)
      warnings.push(
        `${label} rollup is stale (latest ${latest ?? "none"}, expected ${data.day})`,
      );
  }
  // The movers compare two weeks of per-tool rows, which a partial rollup
  // refresh can leave incomplete even when the aggregate tables are current.
  const coverage = toolCoverage(data.toolDaily, data.downloads, data.day);
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
  if (!projectsLatest || projectsLatest < data.day)
    warnings.push(
      `Project snapshot is stale (latest ${projectsLatest ?? "none"}, expected ${data.day}); star figures and milestones may be out of date`,
    );
  return buildDigest({
    day: data.day,
    warnings,
    milestones: projects.milestones,
    sections: [
      audienceSection(data.mau, data.dau, data.day),
      downloadsSection(data.downloads, data.day),
      toolsCurrent
        ? moversSection(data.movers)
        : { title: "Tool movers", lines: [] },
      projects,
      miseReleaseSection(
        data.projects.find((p) => p.name === "mise"),
        data.release,
        data.day,
        now,
      ),
    ],
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
