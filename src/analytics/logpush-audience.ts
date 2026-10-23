// Audience numbers rolled up nightly from Cloudflare Logpush request logs by
// scripts/refresh-logpush-analytics-direct.js. /stats previews them next to
// the Analytics Engine charts until the trailing 30-day MAU window is fully
// covered and the site switches over.

// MAU unions the trailing 30 days of daily user sets.
export const LOGPUSH_MAU_WINDOW_DAYS = 30;
// A day whose logs start later or end earlier than this is partial (the first
// day of logs started mid-afternoon).
const EDGE_TOLERANCE_MS = 5 * 60 * 1000;

export interface LogpushDailyDau {
  date: string;
  dau: number;
  partial: boolean;
}

export interface LogpushAudience {
  daily: LogpushDailyDau[];
  mau: { date: string; mau: number; days_covered: number } | null;
}

interface Row {
  date: string;
  unique_users: number;
  first_event_at: string | null;
  last_event_at: string | null;
  mau: number | null;
  days_covered: number | null;
}

export function isPartialLogpushDay(
  date: string,
  firstEventAt: string | null,
  lastEventAt: string | null,
): boolean {
  if (!firstEventAt || !lastEventAt) return true;
  const start = Date.parse(`${date}T00:00:00Z`);
  const first = Date.parse(firstEventAt);
  const last = Date.parse(lastEventAt);
  if (Number.isNaN(first) || Number.isNaN(last)) return true;
  return (
    first - start > EDGE_TOLERANCE_MS ||
    start + 86400000 - last > EDGE_TOLERANCE_MS
  );
}

// Daily DAU, oldest first, and the most recent MAU row. Returns null when no
// day has been rolled up yet.
export async function getLogpushAudience(
  db: D1Database,
  days = 90,
): Promise<LogpushAudience | null> {
  const { results } = await db
    .prepare(
      `SELECT d.date, d.unique_users, d.first_event_at, d.last_event_at,
        m.mau, m.days_covered
      FROM logpush_daily_dau AS d
      LEFT JOIN logpush_daily_mau AS m ON m.date = d.date
      ORDER BY d.date DESC
      LIMIT ?`,
    )
    .bind(days)
    .all<Row>();
  if (results.length === 0) return null;
  const rows = results.slice().reverse();
  const latestMau = results.find((row) => row.mau !== null);
  return {
    daily: rows.map((row) => ({
      date: row.date,
      dau: Number(row.unique_users),
      partial: isPartialLogpushDay(
        row.date,
        row.first_event_at,
        row.last_event_at,
      ),
    })),
    mau: latestMau
      ? {
          date: latestMau.date,
          mau: Number(latestMau.mau),
          days_covered: Number(latestMau.days_covered),
        }
      : null,
  };
}
