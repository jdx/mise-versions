export interface VersionRow {
  version: string;
  created_at: string | null;
  release_url: string | null;
  prerelease: number;
}

export async function loadToolVersions(
  analyticsDb: D1Database,
  toolId: number,
  options: { stableOnly?: boolean } = {},
): Promise<VersionRow[]> {
  const where = ["tool_id = ?", "from_mise = 1"];

  if (options.stableOnly) {
    where.push("prerelease = 0");
  }

  const query = `
    SELECT version, created_at, release_url, prerelease
    FROM versions
    WHERE ${where.join(" AND ")}
    ORDER BY sort_order ASC, id ASC
  `;

  const result = await analyticsDb
    .prepare(query)
    .bind(toolId)
    .all<VersionRow>();
  return result.results ?? [];
}
