export interface TimelineRelease {
  version: string;
  created_at?: string | null;
  release_url?: string | null;
  prerelease?: boolean;
}
export function releaseMonths(versions: TimelineRelease[]) {
  const dated = versions
    .filter((v) => v.created_at && Number.isFinite(Date.parse(v.created_at)))
    .toSorted((a, b) => Date.parse(a.created_at!) - Date.parse(b.created_at!));
  if (!dated.length) return { months: [], undated: versions.length };
  const groups = new Map<string, TimelineRelease[]>();
  for (const version of dated) {
    const month = new Date(version.created_at!).toISOString().slice(0, 7);
    groups.set(month, [...(groups.get(month) ?? []), version]);
  }
  const first = new Date(dated[0].created_at!);
  first.setUTCDate(1);
  first.setUTCHours(0, 0, 0, 0);
  const last = new Date(dated.at(-1)!.created_at!).toISOString().slice(0, 7);
  const months = [];
  while (first.toISOString().slice(0, 7) <= last) {
    const month = first.toISOString().slice(0, 7);
    months.push({ month, releases: (groups.get(month) ?? []).toReversed() });
    first.setUTCMonth(first.getUTCMonth() + 1);
  }
  return { months, undated: versions.length - dated.length };
}
