export type MauPoint = { date: string; mau: number };

export type MauForecast = {
  target: number;
  targetLabel: string;
  hitDate: string;
  daysAway: number;
  dailySlope: number;
  windows: number[];
  paceLabel: string;
  showOnChart: boolean;
  showInText: boolean;
};

export const PACE_WINDOWS_DAYS = [7, 30, 365] as const;
export const CHART_HORIZON_MONTHS = 16;
export const TEXT_HORIZON_YEARS = 10;

const DAY_MS = 86_400_000;

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

export function formatPaceLabel(windows: number[]): string {
  if (windows.length === 0) return "";
  if (windows.length === 1) return `${windows[0]}-day rate`;
  const names = windows.map((days) => `${days}-day`);
  if (names.length === 2) return `average of ${names[0]} and ${names[1]} rates`;
  return `average of ${names.slice(0, -1).join(", ")}, and ${names.at(-1)} rates`;
}

function snapshotAtOrBefore(
  series: MauPoint[],
  date: string,
): MauPoint | undefined {
  return series.findLast((point) => point.date <= date);
}

function daysBetween(start: string, end: string): number {
  return (parseUtcDate(end) - parseUtcDate(start)) / DAY_MS;
}

function windowRate(
  series: MauPoint[],
  latest: MauPoint,
  windowDays: number,
): number | null {
  const targetDate = formatUtcDate(
    parseUtcDate(latest.date) - windowDays * DAY_MS,
  );
  const baseline = snapshotAtOrBefore(series, targetDate) ?? series[0];
  if (!baseline || baseline.date >= latest.date) return null;

  const spanDays = daysBetween(baseline.date, latest.date);
  if (spanDays < 2 || spanDays < windowDays * 0.5) return null;
  return (latest.mau - baseline.mau) / spanDays;
}

export function blendedDailyPace(points: MauPoint[]): {
  slope: number;
  windows: number[];
} | null {
  const series = points.filter((point) => point.mau > 0);
  const latest = series.at(-1);
  if (!latest) return null;

  const rates: number[] = [];
  const windows: number[] = [];
  for (const windowDays of PACE_WINDOWS_DAYS) {
    const rate = windowRate(series, latest, windowDays);
    if (rate === null) continue;
    rates.push(rate);
    windows.push(windowDays);
  }
  if (rates.length === 0) return null;

  const slope = rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  return { slope, windows };
}

export function forecastNextMillion(points: MauPoint[]): MauForecast | null {
  const series = points.filter((point) => point.mau > 0);
  const latest = series.at(-1);
  if (!latest) return null;

  const pace = blendedDailyPace(series);
  if (pace === null || pace.slope <= 0) return null;

  const target = nextMillion(latest.mau);
  const remaining = target - latest.mau;
  if (remaining <= 0) return null;

  const rawDays = remaining / pace.slope;
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
    dailySlope: pace.slope,
    windows: pace.windows,
    paceLabel: formatPaceLabel(pace.windows),
    showOnChart: hitDate <= chartDeadline,
    showInText: true,
  };
}
