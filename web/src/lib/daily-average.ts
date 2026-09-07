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
