import { sevenDayAverage } from "./daily-average";
import { parseUtcDate, formatUtcDate, type MauPoint } from "./mau-forecast";
export function weeklyMauGains(points: MauPoint[]) {
  const averages = sevenDayAverage(
    points
      .filter((p) => p.mau > 0 && p.date >= "2026-03-01")
      .map((p) => ({ date: p.date, value: p.mau })),
  );
  const byDate = new Map(averages.map((p) => [p.date, p.value]));
  return averages
    .filter((p) => new Date(parseUtcDate(p.date)).getUTCDay() === 0)
    .map((p) => {
      const previous = byDate.get(
        formatUtcDate(parseUtcDate(p.date) - 7 * 86400000),
      );
      return {
        date: p.date,
        value: p.value != null && previous != null ? p.value - previous : null,
      };
    })
    .slice(-16);
}
