import {
  blendedDailyPace,
  formatPaceLabel,
  formatUtcDate,
  parseUtcDate,
} from "./mau-forecast";
export type DailyCount = { date: string; value: number | null };
export function sevenDayAverage(points: DailyCount[]): DailyCount[] {
  const byDate = new Map(points.map((p) => [p.date, p.value]));
  return points.map((point) => {
    const week = Array.from({ length: 7 }, (_, i) =>
      byDate.get(formatUtcDate(parseUtcDate(point.date) - i * 86400000)),
    );
    return {
      date: point.date,
      value: week.every((v) => v !== null && v !== undefined)
        ? (week as number[]).reduce((a, b) => a + b, 0) / 7
        : null,
    };
  });
}
export function nextActivityMilestone(value: number): number {
  const scale = 10 ** Math.floor(Math.log10(Math.max(value, 1)));
  return (
    [1, 2.5, 5, 10].map((n) => n * scale).find((n) => n > value) ?? scale * 10
  );
}
export function activityMilestoneLevels(max: number): number[] {
  const levels: number[] = [];
  for (let scale = 1; scale <= max; scale *= 10)
    for (const n of [1, 2.5, 5]) if (n * scale <= max) levels.push(n * scale);
  return levels;
}
// First day the average reached each milestone. Levels the series already
// started above are skipped, since we never saw them being hit.
export function pastActivityMilestones(averages: DailyCount[]) {
  const valid = averages.filter(
    (p): p is { date: string; value: number } => p.value !== null,
  );
  if (!valid.length) return [];
  const max = Math.max(...valid.map((p) => p.value));
  return activityMilestoneLevels(max)
    .filter((level) => valid[0].value < level)
    .map((level) => ({
      level,
      date: valid.find((p) => p.value >= level)!.date,
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.level - b.level);
}
export function forecastDailyAverage(averages: DailyCount[]) {
  const latest = averages.at(-1);
  if (!latest || latest.value === null) return null;
  const pace = blendedDailyPace(
    averages
      .filter((p): p is { date: string; value: number } => p.value !== null)
      .map((p) => ({ date: p.date, mau: p.value })),
  );
  const target = nextActivityMilestone(latest.value);
  if (!pace || pace.slope <= 0) return null;
  const daysAway = Math.ceil((target - latest.value) / pace.slope);
  if (!Number.isFinite(daysAway) || daysAway > 3652) return null;
  return {
    target,
    daysAway,
    hitDate: formatUtcDate(parseUtcDate(latest.date) + daysAway * 86400000),
    paceLabel: formatPaceLabel(pace.windows),
    showOnChart: daysAway <= 180,
  };
}
