import {
  blendedDailyPace,
  formatPaceLabel,
  formatUtcDate,
  parseUtcDate,
} from "./mau-forecast";
import { sevenDayAverage } from "./daily-average";
export interface StarPoint {
  date: string;
  mise: number;
  homebrew: number;
}
export interface DownloadPoint {
  date: string;
  downloads: number;
  // When the snapshot was taken (UTC). Absent on rows from before mise-analytics recorded it.
  fetchedAt?: string;
}
const validTimestamp = (value: string | undefined): value is string =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value ?? "") &&
  Number.isFinite(Date.parse(value!));
const validDate = (date: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) &&
  new Date(date).toISOString().slice(0, 10) === date;
const validCount = (value: string) =>
  value?.trim() !== "" && /^\d+$/.test(value);

export function parseStarCsv(csv: string): StarPoint[] {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  const keys = header.split(",");
  const mise = keys.indexOf("mise_stars"),
    brew = keys.indexOf("brew_stars"),
    date = keys.indexOf("date");
  if ([mise, brew, date].includes(-1))
    throw new Error("Unexpected competitor CSV columns");
  const result = new Map<string, StarPoint>();
  for (const line of lines) {
    const cells = line.split(",");
    if (
      cells.length !== keys.length ||
      !validDate(cells[date]) ||
      !validCount(cells[mise]) ||
      !validCount(cells[brew])
    )
      continue;
    if (Number(cells[mise]) > 0 && Number(cells[brew]) > 0)
      result.set(cells[date], {
        date: cells[date],
        mise: Number(cells[mise]),
        homebrew: Number(cells[brew]),
      });
  }
  return [...result.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function parseMiseDownloadsCsv(csv: string): DownloadPoint[] {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  // mise-analytics appends columns such as fetched_at; only the first three are read.
  if (!/^date,repo_name,release_downloads(,\w+)*$/.test(header))
    throw new Error("Unexpected download CSV columns");
  const result = new Map<string, DownloadPoint>();
  for (const line of lines) {
    const [date, repo, count, fetchedAt] = line.split(",");
    if (!validDate(date) || !validCount(count) || repo !== "mise") continue;
    result.set(date, {
      date,
      downloads: Number(count),
      ...(validTimestamp(fetchedAt) ? { fetchedAt } : {}),
    });
  }
  return [...result.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Increase over the `days` days ending at the snapshot dated `endDate`
// (default: the latest snapshot).
export function downloadChange(
  points: DownloadPoint[],
  days: number,
  endDate?: string,
): number | null {
  const latest =
    endDate === undefined
      ? points.at(-1)
      : points.find((p) => p.date === endDate);
  if (!latest) return null;
  const baseline = points.find(
    (p) =>
      p.date === formatUtcDate(parseUtcDate(latest.date) - days * 86400000),
  );
  if (!baseline || latest.downloads < baseline.downloads) return null;
  return latest.downloads - baseline.downloads;
}

export function forecastStarCrossover(points: StarPoint[]) {
  const series = points
    .filter((p) => p.mise > 0 && p.homebrew > 0)
    .toSorted((a, b) => a.date.localeCompare(b.date));
  const latest = series.at(-1);
  if (!latest) return null;
  if (latest.mise > latest.homebrew)
    return { status: "ahead" as const, latest };
  const mise = blendedDailyPace(
    series.map((p) => ({ date: p.date, mau: p.mise })),
  );
  const brew = blendedDailyPace(
    series.map((p) => ({ date: p.date, mau: p.homebrew })),
  );
  if (!mise || !brew) return null;
  const closingPace = mise.slope - brew.slope;
  if (closingPace <= 0) return { status: "not-closing" as const, latest };
  // Strictly exceed Homebrew's projected count, rather than just reach a tie.
  const daysAway =
    Math.floor((latest.homebrew - latest.mise) / closingPace) + 1;
  if (daysAway > 3652) return { status: "distant" as const, latest };
  return {
    status: "forecast" as const,
    latest,
    daysAway,
    hitDate: formatUtcDate(parseUtcDate(latest.date) + daysAway * 86400000),
    misePace: mise.slope,
    brewPace: brew.slope,
    stars: latest.mise + mise.slope * daysAway,
    paceLabel: formatPaceLabel(mise.windows),
  };
}

// Snapshots before fetched_at existed were all taken by the 08:15 UTC cron.
const snapshotTime = (point: DownloadPoint) =>
  validTimestamp(point.fetchedAt)
    ? Date.parse(point.fetchedAt)
    : parseUtcDate(point.date) + (8 * 60 + 15) * 60000;
// Release totals are cumulative snapshots. Only adjacent dates give a daily
// increase; missing dates and counter corrections must not become daily spikes.
// Pushes and manual runs also take snapshots, so adjacent dates are not always
// 24 hours apart: each increase is scaled to a per-day rate by the real elapsed time.
export function dailyDownloads(
  points: DownloadPoint[],
): Array<{ date: string; value: number | null }> {
  const series = points.toSorted((a, b) => a.date.localeCompare(b.date));
  return series.map((point, i) => {
    const previous = series[i - 1];
    const delta = previous ? point.downloads - previous.downloads : null;
    const elapsed = previous ? snapshotTime(point) - snapshotTime(previous) : 0;
    return {
      date: point.date,
      value:
        previous &&
        parseUtcDate(point.date) - parseUtcDate(previous.date) === 86400000 &&
        delta !== null &&
        delta >= 0 &&
        elapsed > 0
          ? (delta * 86400000) / elapsed
          : null,
    };
  });
}

// Requests for release binaries on mise.jdx.dev / mise.en.dev per fully
// covered UTC day (mise_release_download_days in D1).
export interface CdnDownloadPoint {
  date: string;
  downloads: number;
}
export interface CombinedDownloadPoint {
  date: string;
  // GitHub + CDN; GitHub alone before CDN counts start; null when a needed
  // part is missing.
  value: number | null;
  github: number | null;
  // null before CDN counts start, and on days they did not cover.
  cdn: number | null;
}
// Adds CDN binary downloads to the daily GitHub increases. CDN requests were
// not recorded before the first covered day (`cdnStart`), so earlier days are
// GitHub alone rather than a guessed total. From then on a day's total needs
// both counts. Days after the last covered CDN day are dropped: the nightly
// rollup has not reached them yet, and GitHub alone would read as a drop.
export function combineDownloads(
  github: Array<{ date: string; value: number | null }>,
  cdn: CdnDownloadPoint[],
): { points: CombinedDownloadPoint[]; cdnStart: string | null } {
  const cdnByDate = new Map(cdn.map((p) => [p.date, p.downloads]));
  const cdnDates = [...cdnByDate.keys()].sort();
  const cdnStart = cdnDates[0] ?? null;
  const cdnEnd = cdnDates.at(-1);
  const githubByDate = new Map(github.map((p) => [p.date, p.value]));
  const dates = [...new Set([...githubByDate.keys(), ...cdnDates])]
    .filter((date) => cdnEnd === undefined || date <= cdnEnd)
    .sort();
  const points = dates.map((date) => {
    const githubValue = githubByDate.get(date) ?? null;
    if (cdnStart === null || date < cdnStart)
      return { date, value: githubValue, github: githubValue, cdn: null };
    const cdnValue = cdnByDate.get(date) ?? null;
    return {
      date,
      value:
        githubValue === null || cdnValue === null
          ? null
          : githubValue + cdnValue,
      github: githubValue,
      cdn: cdnValue,
    };
  });
  return { points, cdnStart };
}
// GitHub's 30-day counter increase plus the CDN binary downloads on the same
// days, ending at `endDate`. Null unless CDN covered every one of those days.
export function combinedDownloadChange(
  github: DownloadPoint[],
  cdn: CdnDownloadPoint[],
  days: number,
  endDate: string,
): number | null {
  const githubChange = downloadChange(github, days, endDate);
  if (githubChange === null) return null;
  const cdnByDate = new Map(cdn.map((p) => [p.date, p.downloads]));
  let cdnTotal = 0;
  for (let i = 0; i < days; i++) {
    const value = cdnByDate.get(
      formatUtcDate(parseUtcDate(endDate) - i * 86400000),
    );
    if (value === undefined) return null;
    cdnTotal += value;
  }
  return githubChange + cdnTotal;
}

const latestAverage = (points: Array<{ date: string; value: number | null }>) =>
  sevenDayAverage(points).at(-1)?.value ?? null;
// Headline numbers for the mise downloads card. Once CDN counts have a
// complete week, the average is GitHub + CDN, split into both parts; a later
// gap in either source keeps the last complete week (its date says which)
// rather than falling back to GitHub alone. Before that first complete week
// (no CDN data, or its first days) the average is GitHub alone and says so.
export function miseDownloadSummary(
  snapshots: DownloadPoint[],
  cdn: CdnDownloadPoint[],
) {
  const githubDaily = dailyDownloads(snapshots);
  const { points, cdnStart } = combineDownloads(githubDaily, cdn);
  // How current the data is: the newest GitHub snapshot or CDN day, which can
  // be later than the week the average ends on.
  const latestObserved =
    [snapshots.at(-1)?.date, ...cdn.map((p) => p.date)]
      .filter((date): date is string => date !== undefined)
      .sort()
      .at(-1) ?? null;
  const total =
    cdnStart === null
      ? undefined
      : sevenDayAverage(points, cdnStart).findLast(
          (p): p is { date: string; value: number } =>
            p.date >= cdnStart && p.value !== null,
        );
  if (cdnStart !== null && total) {
    const window = points.filter(
      (p) =>
        p.date > formatUtcDate(parseUtcDate(total.date) - 7 * 86400000) &&
        p.date <= total.date,
    );
    const totalChange = combinedDownloadChange(snapshots, cdn, 30, total.date);
    return {
      points,
      cdnStart,
      latestObserved,
      combined: true as const,
      date: total.date,
      average: total.value,
      github: latestAverage(window.map((p) => ({ ...p, value: p.github }))),
      cdn: latestAverage(window.map((p) => ({ ...p, value: p.cdn }))),
      change30d: totalChange ?? downloadChange(snapshots, 30, total.date),
      change30dSource: totalChange === null ? "github" : "total",
    };
  }
  const github = sevenDayAverage(githubDaily).at(-1);
  // First day a combined 7-day average can exist, while that is still ahead;
  // null once gaps have pushed it past without a complete week.
  const combinedFrom =
    cdnStart === null
      ? null
      : formatUtcDate(parseUtcDate(cdnStart) + 6 * 86400000);
  const lastDate = points.at(-1)?.date;
  return {
    points,
    cdnStart,
    latestObserved,
    combined: false as const,
    date: github?.date ?? null,
    average: github?.value ?? null,
    github: github?.value ?? null,
    cdn: null,
    change30d: downloadChange(snapshots, 30),
    change30dSource: "github",
    combinedFrom:
      combinedFrom !== null && lastDate !== undefined && combinedFrom > lastDate
        ? combinedFrom
        : null,
  };
}
