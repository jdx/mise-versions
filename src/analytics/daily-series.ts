// Helpers for the date-keyed rollup series the stats page charts.

// Rollup rows for a day are written after that day closes, so the newest days
// in a requested window have no rows until the daily maintenance job runs — and
// that job writes MAU before DAU, so a day is briefly half-populated while it
// is in flight. Drop the tail until a day is rolled up on both sides rather
// than charting it as a day with no activity. Interior gaps are left alone so a
// real outage stays visible.
export function trimPendingRollups<T extends { date: string }>(
  series: T[],
  isRolledUp: (date: string) => boolean,
): T[] {
  let end = series.length;
  while (end > 0 && !isRolledUp(series[end - 1].date)) end--;
  return series.slice(0, end);
}

export const LOGPUSH_MAU_WINDOW_DAYS = 30;

// DAU/MAU come from Cloudflare Logpush (logpush_daily_dau/_mau), which counts
// every mise client including those that only fetch static assets. Dates
// before Logpush started keep the older Analytics Engine rollups so history
// stays charted. A Logpush MAU whose 30-day window is not fully covered yet is
// only a lower bound, so it is used once it at least matches the older number.
export function mergeAudienceRows(
  legacy: {
    dau: Array<{ date: string; dau: number }>;
    mau: Array<{ date: string; mau: number }>;
  },
  logpush: {
    dau: Array<{ date: string; dau: number }>;
    mau: Array<{ date: string; mau: number; days_covered: number }>;
  },
): { dau: Map<string, number>; mau: Map<string, number> } {
  const dau = new Map(legacy.dau.map((r) => [r.date, r.dau]));
  for (const row of logpush.dau) dau.set(row.date, row.dau);

  const mau = new Map(legacy.mau.map((r) => [r.date, r.mau]));
  for (const row of logpush.mau) {
    const older = mau.get(row.date);
    if (
      row.days_covered >= LOGPUSH_MAU_WINDOW_DAYS ||
      older === undefined ||
      row.mau >= older
    ) {
      mau.set(row.date, row.mau);
    }
  }
  return { dau, mau };
}
