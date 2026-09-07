export interface AdoptionPoint {
  date: string;
  stars: number;
  brewRank: number | null;
  brewInstalls: number | null;
  brewPercent: number | null;
}

export function parseAdoptionCsv(csv: string): AdoptionPoint[] {
  const [header, ...lines] = csv.trim().split(/\r?\n/);
  if (header !== "date,brew_rank,brew_installs,brew_pct,github_stars") {
    throw new Error("Unexpected mise analytics CSV columns");
  }
  const points = new Map<string, AdoptionPoint>();
  const number = (value: string) =>
    value?.trim() && Number.isFinite(Number(value)) && Number(value) >= 0
      ? Number(value)
      : null;
  for (const line of lines) {
    const cells = line.split(",");
    const [date, rank, installs, percent, stars] = cells;
    if (
      cells.length !== 5 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      number(stars) === null
    )
      continue;
    points.set(date, {
      date,
      stars: number(stars)!,
      brewRank: number(rank),
      brewInstalls: number(installs),
      brewPercent: number(percent),
    });
  }
  return [...points.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Require the exact comparison day; gaps must not silently become a 30-day delta.
export function starChange(
  points: AdoptionPoint[],
  days: number,
): number | null {
  const latest = points.at(-1);
  if (!latest) return null;
  const date = new Date(latest.date);
  date.setUTCDate(date.getUTCDate() - days);
  const previous = points.find(
    (p) => p.date === date.toISOString().slice(0, 10),
  );
  return previous ? latest.stars - previous.stars : null;
}
