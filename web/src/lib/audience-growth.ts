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
export function backendShares(
  rows: { date: string; backend: string; downloads: number }[],
) {
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const totals = new Map<string, number>();
  for (const row of rows)
    totals.set(row.backend, (totals.get(row.backend) ?? 0) + row.downloads);
  const top = [...totals]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);
  const names = [
    ...top,
    ...([...totals.keys()].some((name) => !top.includes(name))
      ? ["Other"]
      : []),
  ];
  const values = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.date}:${top.includes(row.backend) ? row.backend : "Other"}`;
    values.set(key, (values.get(key) ?? 0) + row.downloads);
  }
  const averaged = names.map((name) => ({
    name,
    points: sevenDayAverage(
      dates.map((date) => ({
        date,
        value: values.get(`${date}:${name}`) ?? 0,
      })),
    ),
  }));
  return averaged.map((s) => ({
    name: s.name,
    points: s.points
      .map((p, i) => {
        const total = averaged.reduce(
          (sum, s) => sum + (s.points[i].value ?? 0),
          0,
        );
        return {
          date: p.date,
          value: p.value === null || !total ? null : (p.value / total) * 100,
        };
      })
      .slice(-90),
  }));
}
