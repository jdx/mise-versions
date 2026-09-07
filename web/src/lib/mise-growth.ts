import {
  blendedDailyPace,
  formatPaceLabel,
  formatUtcDate,
  parseUtcDate,
} from "./mau-forecast";
export interface StarPoint {
  date: string;
  mise: number;
  homebrew: number;
}
export interface DownloadPoint {
  date: string;
  downloads: number;
}
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
  if (header !== "date,repo_name,release_downloads")
    throw new Error("Unexpected download CSV columns");
  const result = new Map<string, DownloadPoint>();
  for (const line of lines) {
    const [date, repo, count, ...extra] = line.split(",");
    if (
      extra.length ||
      !validDate(date) ||
      !validCount(count) ||
      repo !== "mise"
    )
      continue;
    result.set(date, { date, downloads: Number(count) });
  }
  return [...result.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function downloadChange(
  points: DownloadPoint[],
  days: number,
): number | null {
  const latest = points.at(-1);
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

// Release totals are cumulative snapshots. Only adjacent dates give a daily
// increase; missing dates and counter corrections must not become daily spikes.
export function dailyDownloads(
  points: DownloadPoint[],
): Array<{ date: string; value: number | null }> {
  const series = points.toSorted((a, b) => a.date.localeCompare(b.date));
  return series.map((point, i) => {
    const previous = series[i - 1];
    const delta = previous ? point.downloads - previous.downloads : null;
    return {
      date: point.date,
      value:
        previous &&
        parseUtcDate(point.date) - parseUtcDate(previous.date) === 86400000 &&
        delta !== null &&
        delta >= 0
          ? delta
          : null,
    };
  });
}
