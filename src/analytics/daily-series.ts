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

type LegacyAudience = {
  dau: Array<{ date: string; dau: number }>;
  mau: Array<{ date: string; mau: number }>;
};
type LogpushMauRow = { date: string; mau: number; days_covered: number };
type LogpushAudience = {
  dau: Array<{ date: string; dau: number }>;
  mau: LogpushMauRow[];
};

// DAU/MAU come from Cloudflare Logpush (logpush_daily_dau/_mau), which counts
// every mise client including those that only fetch static assets. The older
// Analytics Engine rollups fill in only the dates before Logpush took over:
//
// - DAU: from the first Logpush DAU day (`starts.dau`) on, only Logpush rows
//   count, so a missed Logpush day shows as a gap rather than the much smaller
//   older number.
// - MAU: from the first Logpush MAU day whose 30-day window is fully covered
//   (`starts.mau`) on, only complete Logpush rows count. Before that, a partial
//   window is a lower bound: it replaces the older number for the same date
//   only when it is at least as large, and is never used on its own.
export function mergeAudienceRows(
  legacy: LegacyAudience,
  logpush: LogpushAudience,
  starts: { dau?: string | null; mau?: string | null } = {},
): { dau: Map<string, number>; mau: Map<string, number> } {
  const before = (date: string, start?: string | null) =>
    !start || date < start;

  const dau = new Map(
    legacy.dau
      .filter((r) => before(r.date, starts.dau))
      .map((r) => [r.date, r.dau]),
  );
  for (const row of logpush.dau) dau.set(row.date, row.dau);

  const mau = new Map(
    legacy.mau
      .filter((r) => before(r.date, starts.mau))
      .map((r) => [r.date, r.mau]),
  );
  for (const row of logpush.mau) {
    if (row.days_covered >= LOGPUSH_MAU_WINDOW_DAYS) {
      mau.set(row.date, row.mau);
      continue;
    }
    const older = mau.get(row.date);
    if (
      before(row.date, starts.mau) &&
      older !== undefined &&
      row.mau >= older
    ) {
      mau.set(row.date, row.mau);
    }
  }
  return { dau, mau };
}

// The header MAU: the newest complete Logpush MAU once one exists, even if a
// lagging Logpush job leaves it older than the newest Analytics Engine row;
// otherwise the newest of the older number and a same-date partial Logpush
// window that already exceeds it.
export function currentMau(latest: {
  legacy?: { date: string; mau: number };
  logpush?: LogpushMauRow;
  logpushComplete?: LogpushMauRow;
}): number {
  if (latest.logpushComplete) return latest.logpushComplete.mau;
  const { mau } = mergeAudienceRows(
    { dau: [], mau: latest.legacy ? [latest.legacy] : [] },
    { dau: [], mau: latest.logpush ? [latest.logpush] : [] },
  );
  const date = [...mau.keys()].sort().pop();
  return date ? (mau.get(date) ?? 0) : 0;
}
