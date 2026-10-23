// Types for audience.js (see there for the rules).
export declare const LOGPUSH_MAU_WINDOW_DAYS: number;

export type LegacyAudience = {
  dau: Array<{ date: string; dau: number }>;
  mau: Array<{ date: string; mau: number }>;
};
export type LogpushMauRow = { date: string; mau: number; days_covered: number };
export type LogpushAudience = {
  dau: Array<{ date: string; dau: number }>;
  mau: LogpushMauRow[];
};

export declare function mergeAudienceRows(
  legacy: LegacyAudience,
  logpush: LogpushAudience,
  starts?: { dau?: string | null; mau?: string | null },
): { dau: Map<string, number>; mau: Map<string, number> };

export declare function currentMau(latest: {
  legacy?: { date: string; mau: number };
  logpush?: LogpushMauRow;
  logpushComplete?: LogpushMauRow;
}): number;
