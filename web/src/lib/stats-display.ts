import { parseUtcDate, formatUtcDate } from "./mau-forecast";

export function forecastDate(date: string): string {
  return new Date(parseUtcDate(date)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function freshness(date?: string, now = Date.now()): string {
  if (!date || !Number.isFinite(parseUtcDate(date)))
    return "Data date unavailable";
  const age = Math.floor(
    (parseUtcDate(formatUtcDate(now)) - parseUtcDate(date)) / 86400000,
  );
  return age > 2
    ? `Data delayed · latest observation ${date} (${age} days ago)`
    : `Data through ${date}`;
}
