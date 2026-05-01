export interface VersionRow {
  version: string;
  created_at: string | null;
  release_url: string | null;
  prerelease: number;
}

interface VersionsTableColumns {
  fromMise: boolean;
  prerelease: boolean;
  sortOrder: boolean;
}

async function getVersionsTableColumns(
  analyticsDb: D1Database,
): Promise<VersionsTableColumns> {
  const result = await analyticsDb
    .prepare("PRAGMA table_info(versions)")
    .all<{ name: string }>();
  const names = new Set((result.results ?? []).map((col) => col.name));

  return {
    fromMise: names.has("from_mise"),
    prerelease: names.has("prerelease"),
    sortOrder: names.has("sort_order"),
  };
}

export async function loadToolVersions(
  analyticsDb: D1Database,
  toolId: number,
  options: { stableOnly?: boolean } = {},
): Promise<VersionRow[]> {
  const columns = await getVersionsTableColumns(analyticsDb);
  const selectPrerelease = columns.prerelease ? "prerelease" : "0 AS prerelease";
  const where = ["tool_id = ?"];

  if (columns.fromMise) {
    where.push("from_mise = 1");
  }

  if (options.stableOnly && columns.prerelease) {
    where.push("prerelease = 0");
  }

  const orderBy = columns.sortOrder ? "sort_order ASC, id ASC" : "id ASC";
  const query = `
    SELECT version, created_at, release_url, ${selectPrerelease}
    FROM versions
    WHERE ${where.join(" AND ")}
    ORDER BY ${orderBy}
  `;

  const result = await analyticsDb.prepare(query).bind(toolId).all<VersionRow>();
  return result.results ?? [];
}
