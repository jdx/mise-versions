export type MauPoint = { date: string; mau: number };

export type MauForecast = {
  target: number;
  targetLabel: string;
  hitDate: string;
  daysAway: number;
  dailySlope: number;
  windowDays: number;
  showOnChart: boolean;
  showInText: boolean;
};

export const FORECAST_WINDOW_DAYS = 21;
export const CHART_HORIZON_MONTHS = 16;
export const TEXT_HORIZON_YEARS = 10;

const DAY_MS = 86_400_000;
const MIN_WINDOW_POINTS = 7;

export function parseUtcDate(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function formatUtcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addUtcMonths(date: string, months: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next.toISOString().slice(0, 10);
}

export function nextMillion(mau: number): number {
  return (Math.floor(Math.max(mau, 0) / 1_000_000) + 1) * 1_000_000;
}

export function formatMillionLabel(target: number): string {
  return `${target / 1_000_000}M`;
}

export function formatForecastRelative(daysAway: number): string {
  if (daysAway <= 0) return "today";
  if (daysAway === 1) return "tomorrow";
  if (daysAway < 21) return `in ${daysAway} days`;
  if (daysAway < 60) {
    const weeks = Math.max(1, Math.round(daysAway / 7));
    return weeks === 1 ? "in 1 week" : `in ${weeks} weeks`;
  }
  if (daysAway < 730) {
    const months = Math.max(1, Math.round(daysAway / 30.44));
    return months === 1 ? "in 1 month" : `in ${months} months`;
  }
  const years = daysAway / 365.25;
  const rounded = years >= 10 ? years.toFixed(0) : years.toFixed(1);
  return `in ${rounded} years`;
}

function linearSlope(points: MauPoint[]): number | null {
  const n = points.length;
  if (n < MIN_WINDOW_POINTS) return null;

  const origin = parseUtcDate(points[0].date);
  const xs = points.map(
    (point) => (parseUtcDate(point.date) - origin) / DAY_MS,
  );
  const ys = points.map((point) => point.mau);
  const meanX = xs.reduce((sum, x) => sum + x, 0) / n;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    sxx += dx * dx;
    sxy += dx * (ys[i] - meanY);
  }
  if (sxx === 0) return null;
  return sxy / sxx;
}

export function forecastNextMillion(points: MauPoint[]): MauForecast | null {
  const series = points.filter((point) => point.mau > 0);
  const latest = series.at(-1);
  if (!latest) return null;

  const windowStart = formatUtcDate(
    parseUtcDate(latest.date) - FORECAST_WINDOW_DAYS * DAY_MS,
  );
  const window = series.filter((point) => point.date >= windowStart);
  const slope = linearSlope(
    window.length >= MIN_WINDOW_POINTS ? window : series,
  );
  if (slope === null || slope <= 0) return null;

  const target = nextMillion(latest.mau);
  const remaining = target - latest.mau;
  if (remaining <= 0) return null;

  const rawDays = remaining / slope;
  if (!Number.isFinite(rawDays) || rawDays <= 0) return null;

  const hitMs = parseUtcDate(latest.date) + rawDays * DAY_MS;
  const hitDate = formatUtcDate(hitMs);
  const daysAway = Math.max(
    0,
    Math.round((parseUtcDate(hitDate) - parseUtcDate(latest.date)) / DAY_MS),
  );
  const chartDeadline = addUtcMonths(latest.date, CHART_HORIZON_MONTHS);
  const textDeadline = addUtcMonths(latest.date, TEXT_HORIZON_YEARS * 12);

  if (hitDate > textDeadline) return null;

  return {
    target,
    targetLabel: formatMillionLabel(target),
    hitDate,
    daysAway,
    dailySlope: slope,
    windowDays: FORECAST_WINDOW_DAYS,
    showOnChart: hitDate <= chartDeadline,
    showInText: true,
  };
}
