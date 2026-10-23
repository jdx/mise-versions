// Audience (DAU/MAU) merge rules shared by the site (src/analytics/stats.ts,
// trends.ts via daily-series.ts) and the daily digest (scripts/daily-digest.js).
// Plain JavaScript with a .d.ts so both TypeScript and Node scripts import it.

export const LOGPUSH_MAU_WINDOW_DAYS = 30;

// DAU/MAU come from Cloudflare Logpush (logpush_daily_dau/_mau), which counts
// every mise client including those that only fetch static assets. The older
// Analytics Engine rollups fill in only the dates before Logpush took over:
//
// - DAU: from the first Logpush DAU day (`starts.dau`) on, only Logpush rows
//   count, so a missed Logpush day shows as a gap rather than the much smaller
//   older number.
// - MAU: from the first Logpush MAU day whose 30-day window is fully covered
//   (`starts.mau`) on, only Logpush rows count, whatever their coverage: a
//   window missing a skipped day is still far closer than the older number.
//   Before that, a partial window is a lower bound during the first month: it
//   replaces the older number for the same date only when it is at least as
//   large, and is never used on its own.
export function mergeAudienceRows(legacy, logpush, starts = {}) {
  const before = (date, start) => !start || date < start;

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
    if (
      row.days_covered >= LOGPUSH_MAU_WINDOW_DAYS ||
      !before(row.date, starts.mau)
    ) {
      mau.set(row.date, row.mau);
      continue;
    }
    const older = mau.get(row.date);
    if (older !== undefined && row.mau >= older) mau.set(row.date, row.mau);
  }
  return { dau, mau };
}

// The header MAU. Once Logpush has a fully covered window, the newest Logpush
// row (even one with a skipped day in its window, and even when a lagging
// Logpush job leaves it older than the newest Analytics Engine row);
// otherwise the newest of the older number and a same-date partial Logpush
// window that already exceeds it.
export function currentMau(latest) {
  if (latest.logpushComplete) {
    return (latest.logpush ?? latest.logpushComplete).mau;
  }
  const { mau } = mergeAudienceRows(
    { dau: [], mau: latest.legacy ? [latest.legacy] : [] },
    { dau: [], mau: latest.logpush ? [latest.logpush] : [] },
  );
  const date = [...mau.keys()].sort().pop();
  return date ? (mau.get(date) ?? 0) : 0;
}
