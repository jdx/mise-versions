export interface TimelineRelease {
  version: string;
  created_at?: string | null;
  release_url?: string | null;
  prerelease?: boolean;
}
export function releaseDays(versions: TimelineRelease[]) {
  const dated = versions
    .filter((v) => v.created_at && Number.isFinite(Date.parse(v.created_at)))
    .toSorted((a, b) => Date.parse(b.created_at!) - Date.parse(a.created_at!));
  const groups = new Map<string, TimelineRelease[]>();
  for (const version of dated) {
    const date = new Date(version.created_at!).toISOString().slice(0, 10);
    const releases = groups.get(date) ?? [];
    releases.push(version);
    groups.set(date, releases);
  }
  const seen = new Set<string>();
  const days = [...groups].toReversed().map(([date, releases]) => {
    const milestones: string[] = [];
    for (const release of releases) {
      // Only stable, top-level versions define a release generation.
      const match = /^v?(\d+)\.(\d+)(?:\.\d+)?(?:\+[^\s]+)?$/.exec(
        release.version,
      );
      if (!match || release.prerelease) continue;
      const label =
        Number(match[1]) === 0
          ? `0.${Number(match[2])}`
          : String(Number(match[1]));
      if (!seen.has(label)) {
        seen.add(label);
        milestones.push(label);
      }
    }
    return { date, releases, milestones };
  });
  return { days, undated: versions.length - dated.length };
}
