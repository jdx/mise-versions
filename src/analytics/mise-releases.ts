// Download counts for mise's own release folders (mise.jdx.dev/v<version>/),
// rolled up nightly from Logpush by scripts/lib/mise-release-downloads.js.
// jdx/mise reads them to prune release folders nobody downloads, so the
// response always says how many complete days it covers.

export const MISE_RELEASE_DOWNLOADS_DEFAULT_DAYS = 30;
// Raw Logpush logs expire after 35 days, so no more can ever be backfilled.
export const MISE_RELEASE_DOWNLOADS_MAX_DAYS = 35;

export interface MiseReleaseDownloads {
  days: number;
  covered_days: number;
  first_covered_date: string | null;
  last_covered_date: string | null;
  versions: Record<string, { binary: number; other: number }>;
}

// `?days=` as an integer from 1 to MISE_RELEASE_DOWNLOADS_MAX_DAYS; null when
// it is anything else.
export function parseMiseReleaseDays(value: string | null): number | null {
  if (value === null) return MISE_RELEASE_DOWNLOADS_DEFAULT_DAYS;
  if (!/^\d{1,3}$/.test(value)) return null;
  const days = Number(value);
  return days >= 1 && days <= MISE_RELEASE_DOWNLOADS_MAX_DAYS ? days : null;
}

interface Row {
  covered_days: number;
  first_covered_date: string | null;
  last_covered_date: string | null;
  version: string | null;
  binary_requests: number | null;
  other_requests: number | null;
}

// Sums the `days` most recent covered days in one query. Days the rollup
// skipped or could not fully cover are not counted, so the summed days can
// span more calendar days than `days`; first_covered_date shows how far back
// they go.
export async function getMiseReleaseDownloads(
  db: D1Database,
  days: number,
): Promise<MiseReleaseDownloads> {
  const { results } = await db
    .prepare(
      `WITH covered AS (
        SELECT date FROM mise_release_download_days
        ORDER BY date DESC
        LIMIT ?
      )
      SELECT
        span.covered_days,
        span.first_covered_date,
        span.last_covered_date,
        totals.version,
        totals.binary_requests,
        totals.other_requests
      FROM (
        SELECT
          COUNT(*) AS covered_days,
          MIN(date) AS first_covered_date,
          MAX(date) AS last_covered_date
        FROM covered
      ) AS span
      LEFT JOIN (
        SELECT
          d.version,
          SUM(d.binary_requests) AS binary_requests,
          SUM(d.other_requests) AS other_requests
        FROM mise_release_daily_downloads AS d
        JOIN covered AS c ON c.date = d.date
        GROUP BY d.version
      ) AS totals ON 1 = 1
      ORDER BY totals.version`,
    )
    .bind(days)
    .all<Row>();

  const first = results[0];
  const versions: MiseReleaseDownloads["versions"] = {};
  for (const row of results) {
    if (row.version === null) continue;
    versions[row.version] = {
      binary: Number(row.binary_requests ?? 0),
      other: Number(row.other_requests ?? 0),
    };
  }
  return {
    days,
    covered_days: Number(first?.covered_days ?? 0),
    first_covered_date: first?.first_covered_date ?? null,
    last_covered_date: first?.last_covered_date ?? null,
    versions,
  };
}
