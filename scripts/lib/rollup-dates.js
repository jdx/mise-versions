// Date selection for the daily rollup refreshers.
//
// Rollups are keyed by UTC calendar day, so a day can only be rolled up once it
// is over. Writing a row for the current UTC day stores a partial count that
// then sits in the table until the next scheduled refresh overwrites it, which
// shows up on the stats page as a daily dip. These helpers keep every refresher
// on the last complete UTC day or earlier.

export function dateStrAgo(baseDate, daysAgo) {
  const date = new Date(`${baseDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().split("T")[0];
}

export function lastCompleteUtcDate(now = Date.now()) {
  return dateStrAgo(new Date(now).toISOString().split("T")[0], 1);
}

// The `days` complete UTC days ending at `baseDate`, newest first so the most
// recently completed day is refreshed before older backfill dates. A missing or
// too-recent `baseDate` is clamped to the last complete UTC day.
export function completedDates(baseDate, days, now = Date.now()) {
  const latest = lastCompleteUtcDate(now);
  const start = baseDate && baseDate < latest ? baseDate : latest;
  return Array.from({ length: days }, (_, i) => dateStrAgo(start, i));
}
