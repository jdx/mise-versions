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
