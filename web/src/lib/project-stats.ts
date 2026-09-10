import { dailyDownloads } from "./mise-growth";
import { sevenDayAverage } from "./daily-average";
import { parseUtcDate, formatUtcDate } from "./mau-forecast";
export type ProjectPoint = {
  date: string;
  stars: number;
  rank: number | null;
  installs: number | null;
};
export type Project = {
  repo: string;
  name: string;
  history: ProjectPoint[];
  downloads: { date: string; downloads: number }[];
};
export type Comparison = {
  name: string;
  series: { name: string; points: { date: string; value: number }[] }[];
};
const validDate = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(parseUtcDate(s)) &&
  formatUtcDate(parseUtcDate(s)) === s;
const count = (s: string) => (/^\d+$/.test(s ?? "") ? Number(s) : null);
function csv(text: string, header: string) {
  const [first, ...rows] = text.trim().split(/\r?\n/);
  if (first !== header) throw new Error(`Unexpected CSV header: ${first}`);
  return rows
    .map((row) => row.split(","))
    .filter(
      (row) => row.length === first.split(",").length && validDate(row[0]),
    );
}
export function parseProjects(
  list: string,
  stats: string,
  downloads: string,
): Project[] {
  const projects = list
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"))
    .map((repo) => {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
        throw new Error(`Invalid repository: ${repo}`);
      return {
        repo,
        name: repo.split("/")[1],
        history: [],
        downloads: [],
      } as Project;
    });
  const histories = new Map(
    projects.map((p) => [p.name, new Map<string, ProjectPoint>()]),
  );
  const counts = new Map(
    projects.map((p) => [
      p.name,
      new Map<string, { date: string; downloads: number }>(),
    ]),
  );
  for (const [date, name, stars, rank, installs] of csv(
    stats,
    "date,repo_name,github_stars,brew_rank,brew_installs,brew_pct",
  )) {
    const value = count(stars);
    if (value !== null && value > 0)
      histories
        .get(name)
        ?.set(date, {
          date,
          stars: value,
          rank: count(rank) || null,
          installs: count(installs),
        });
  }
  for (const [date, name, value] of csv(
    downloads,
    "date,repo_name,release_downloads",
  )) {
    const n = count(value);
    if (n !== null) counts.get(name)?.set(date, { date, downloads: n });
  }
  return projects
    .map((p) => ({
      ...p,
      history: [...histories.get(p.name)!.values()].sort((a, b) =>
        a.date.localeCompare(b.date),
      ),
      downloads: [...counts.get(p.name)!.values()].sort((a, b) =>
        a.date.localeCompare(b.date),
      ),
    }))
    .filter((p) => p.history.length);
}
export function parseComparison(name: string, text: string): Comparison {
  const header = text.trim().split(/\r?\n/)[0];
  const keys = header.split(",");
  if (keys[0] !== "date" || keys.slice(1).some((k) => !/^\w+_stars$/.test(k)))
    throw new Error("Invalid comparison columns");
  const rows = csv(text, header);
  return {
    name,
    series: keys
      .slice(1)
      .map((key, i) => ({
        name: key.replace(/_stars$/, ""),
        points: [
          ...new Map(
            rows
              .filter((r) => (count(r[i + 1]) ?? 0) > 0)
              .map((r) => [r[0], { date: r[0], value: count(r[i + 1])! }]),
          ).values(),
        ].sort((a, b) => a.date.localeCompare(b.date)),
      })),
  };
}
export function projectSummary(p: Project) {
  const latest = p.history.at(-1)!;
  const baseline = p.history.find(
    (v) => v.date === formatUtcDate(parseUtcDate(latest.date) - 30 * 86400000),
  );
  const gain = baseline ? latest.stars - baseline.stars : null;
  const average = sevenDayAverage(dailyDownloads(p.downloads)).at(-1);
  return {
    latest,
    gain,
    percent: baseline && gain !== null ? (gain / baseline.stars) * 100 : null,
    average,
  };
}
// Compare projects on exactly the same dates, never since their individual first observation.
export function projectComparison(
  projects: Project[],
  end: string,
  percent: boolean,
) {
  const start = formatUtcDate(parseUtcDate(end) - 30 * 86400000);
  return projects.flatMap((p) => {
    const baseline = p.history.find((v) => v.date === start);
    if (!baseline || !p.history.some((v) => v.date === end)) return [];
    return [
      {
        name: p.name,
        points: p.history
          .filter((v) => v.date >= start && v.date <= end)
          .map((v) => ({
            date: v.date,
            value: percent
              ? ((v.stars - baseline.stars) / baseline.stars) * 100
              : v.stars - baseline.stars,
          })),
      },
    ];
  });
}
export function projectMilestones(p: Project) {
  const events: { date: string; text: string }[] = [];
  for (const target of [
    100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000,
  ]) {
    const i = p.history.findIndex((v) => v.stars >= target);
    if (i > 0)
      events.push({
        date: p.history[i].date,
        text: `${p.name} reached ${target.toLocaleString("en-US")} stars`,
      });
  }
  const rankPoints = p.history.filter((v) => v.rank !== null);
  if (rankPoints.length) {
    const best = Math.min(...rankPoints.map((v) => v.rank!));
    const first = rankPoints.find((v) => v.rank === best)!;
    events.push({
      date: first.date,
      text: `${p.name} reached its best recorded Homebrew rank: #${best}`,
    });
    for (const target of [100, 50, 25, 10]) {
      const i = rankPoints.findIndex((v) => v.rank! <= target);
      if (i > 0)
        events.push({
          date: rankPoints[i].date,
          text: `${p.name} entered the Homebrew top ${target}`,
        });
    }
  }
  const weeks = sevenDayAverage(dailyDownloads(p.downloads)).filter(
    (v) => v.value !== null && new Date(parseUtcDate(v.date)).getUTCDay() === 0,
  );
  const best = weeks.reduce<(typeof weeks)[number] | undefined>(
    (best, v) => (!best || v.value! > best.value! ? v : best),
    undefined,
  );
  if (best)
    events.push({
      date: best.date,
      text: `${p.name}'s best recorded complete download week: ${Math.round(best.value! * 7).toLocaleString("en-US")} downloads`,
    });
  return events;
}
