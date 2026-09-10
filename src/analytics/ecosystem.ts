export type BackendDay = { date: string; backend: string; downloads: number };
export type PlatformCount = { os: string; arch: string; downloads: number };
export type Momentum = {
  tool: string;
  current: number;
  previous: number;
  gain: number;
  percent: number | null;
};
export function rankMomentum(
  rows: { tool: string; current: number; previous: number }[],
): Momentum[] {
  return rows
    .filter((r) => Math.max(r.current, r.previous) >= 100)
    .map((r) => ({
      ...r,
      gain: r.current - r.previous,
      percent:
        r.previous > 0 ? ((r.current - r.previous) / r.previous) * 100 : null,
    }))
    .sort((a, b) => b.gain - a.gain || a.tool.localeCompare(b.tool));
}
export async function getEcosystemInsights(db: D1Database, now = Date.now()) {
  const date = (days: number) =>
    new Date(now - days * 86400000).toISOString().slice(0, 10);
  const today = date(0),
    start = date(30),
    week = date(7),
    previous = date(14);
  const results = await db.batch([
    db
      .prepare(
        `SELECT COALESCE(p.os,'unknown') AS os, COALESCE(p.arch,'unknown') AS arch, SUM(s.downloads) AS downloads FROM daily_tool_platform_stats s LEFT JOIN platforms p ON p.id=s.platform_id WHERE s.date>=? AND s.date<? GROUP BY p.os,p.arch ORDER BY downloads DESC`,
      )
      .bind(start, today),
    db
      .prepare(
        `SELECT MAX(date) AS latest, COUNT(DISTINCT date) AS days FROM daily_tool_platform_stats WHERE date>=? AND date<?`,
      )
      .bind(start, today),
    db
      .prepare(
        `SELECT date,backend_type AS backend,SUM(downloads) AS downloads FROM daily_backend_stats WHERE date>=? AND date<? GROUP BY date,backend_type ORDER BY date,backend_type`,
      )
      .bind(date(96), today),
    db
      .prepare(
        `SELECT t.name AS tool,SUM(CASE WHEN s.date>=? THEN s.downloads ELSE 0 END) AS current,SUM(CASE WHEN s.date<? THEN s.downloads ELSE 0 END) AS previous FROM daily_tool_stats s JOIN tools t ON t.id=s.tool_id WHERE s.date>=? AND s.date<? GROUP BY t.id,t.name`,
      )
      .bind(week, week, previous, today),
    db
      .prepare(
        `SELECT MAX(date) AS latest,COUNT(DISTINCT date) AS days FROM daily_tool_stats WHERE date>=? AND date<?`,
      )
      .bind(previous, today),
  ]);
  return {
    start,
    end: date(1),
    platforms: results[0].results as PlatformCount[],
    platformCoverage: results[1].results[0] as {
      latest: string | null;
      days: number;
    },
    backends: results[2].results as BackendDay[],
    momentum: rankMomentum(
      results[3].results as {
        tool: string;
        current: number;
        previous: number;
      }[],
    ),
    momentumCoverage: results[4].results[0] as {
      latest: string | null;
      days: number;
    },
  };
}
