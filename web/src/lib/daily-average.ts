import {
  blendedDailyPace,
  formatPaceLabel,
  formatUtcDate,
  parseUtcDate,
} from "./mau-forecast";
export type DailyCount = { date: string; value: number | null };
// `breakDate` marks where the series starts measuring something more (for
// mise downloads, the day CDN counts begin). A week that spans it would mix
// both measures, so it has no average.
export function sevenDayAverage(
  points: DailyCount[],
  breakDate?: string,
): DailyCount[] {
  const byDate = new Map(points.map((p) => [p.date, p.value]));
  return points.map((point) => {
    const time = parseUtcDate(point.date);
    const spansBreak =
      breakDate !== undefined &&
      point.date >= breakDate &&
      formatUtcDate(time - 6 * 86400000) < breakDate;
    const week = Array.from({ length: 7 }, (_, i) =>
      byDate.get(formatUtcDate(time - i * 86400000)),
    );
    return {
      date: point.date,
      value:
        !spansBreak && week.every((v) => v !== null && v !== undefined)
          ? (week as number[]).reduce((a, b) => a + b, 0) / 7
          : null,
    };
  });
}
// The part of `averages` measured the same way as the latest day.
function latestEra(averages: DailyCount[], breakDate?: string) {
  const latest = averages.at(-1);
  return breakDate && latest && latest.date >= breakDate
    ? averages.filter((p) => p.date >= breakDate)
    : averages;
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
// started above are skipped, since we never saw them being hit. With a
// `breakDate`, each side is judged on its own, so a jump caused by starting to
// measure more is not reported as a milestone; a level is reported once.
export function pastActivityMilestones(
  averages: DailyCount[],
  breakDate?: string,
): Array<{ level: number; date: string; value: number }> {
  if (breakDate) {
    const before = pastActivityMilestones(
      averages.filter((p) => p.date < breakDate),
    );
    const levels = new Set(before.map((m) => m.level));
    return [
      ...before,
      ...pastActivityMilestones(
        averages.filter((p) => p.date >= breakDate),
      ).filter((m) => !levels.has(m.level)),
    ];
  }
  const valid = averages.filter(
    (p): p is { date: string; value: number } => p.value !== null,
  );
  if (!valid.length) return [];
  const max = Math.max(...valid.map((p) => p.value));
  return activityMilestoneLevels(max)
    .filter((level) => valid[0].value < level)
    .map((level) => {
      const hit = valid.find((p) => p.value >= level)!;
      return { level, date: hit.date, value: hit.value };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.level - b.level);
}
// With a `breakDate`, the pace only uses averages measured the same way as
// the latest one.
export function forecastDailyAverage(
  allAverages: DailyCount[],
  breakDate?: string,
) {
  const averages = latestEra(allAverages, breakDate);
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
