import { parseUtcDate, formatUtcDate } from "./mau-forecast";

// A calendar week conveys forecast precision without implying a confidence interval.
export function forecastWeek(date: string): string {
  const ms = parseUtcDate(date);
  const day = new Date(ms).getUTCDay();
  const monday = ms - ((day + 6) % 7) * 86400000;
  return `Week of ${new Date(monday).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
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
