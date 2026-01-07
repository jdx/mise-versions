// Centralized data loading from D1
import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';

// Pagination types
export interface ToolsQueryParams {
  page?: number;
  limit?: number;
  search?: string;
  sort?: 'name' | 'downloads' | 'updated';
  backends?: string[];
}

export interface PaginatedToolsResult {
  tools: ToolMeta[];
  downloads: Record<string, number>;
  total_count: number;
  page: number;
  limit: number;
  total_pages: number;
  backendCounts: Record<string, number>;
}

export interface ToolMeta {
  name: string;
  latest_version: string;
  latest_stable_version?: string;
  version_count: number;
  last_updated: string | null;
  description?: string;
  backends?: string[];
  github?: string;
  homepage?: string;
  repo_url?: string;
  license?: string;
  authors?: string[];
  security?: Array<{ type: string; algorithm?: string }>;
  package_urls?: Record<string, string>;
  aqua_link?: string;
}

export interface ToolsData {
  tool_count: number;
  tools: ToolMeta[];
}

interface ToolRow {
  name: string;
  latest_version: string | null;
  latest_stable_version: string | null;
  version_count: number | null;
  last_updated: string | null;
  description: string | null;
  github: string | null;
  homepage: string | null;
  repo_url: string | null;
  license: string | null;
  backends: string | null;
  authors: string | null;
  security: string | null;
  package_urls: string | null;
  aqua_link: string | null;
}

/**
 * Load tools manifest from D1 database
 */
export async function loadToolsJson(analyticsDb: D1Database): Promise<ToolsData | null> {
  const db = drizzle(analyticsDb);

  const rows = await db.all<ToolRow>(sql`
    SELECT
      name,
      latest_version,
      latest_stable_version,
      version_count,
      last_updated,
      description,
      github,
      homepage,
      repo_url,
      license,
      backends,
      authors,
      security,
      package_urls,
      aqua_link
    FROM tools
    WHERE latest_version IS NOT NULL
    ORDER BY name
  `);

  const tools: ToolMeta[] = rows.map(row => ({
    name: row.name,
    latest_version: row.latest_version || '',
    latest_stable_version: row.latest_stable_version || undefined,
    version_count: row.version_count || 0,
    last_updated: row.last_updated,
    description: row.description || undefined,
    github: row.github || undefined,
    homepage: row.homepage || undefined,
    repo_url: row.repo_url || undefined,
    license: row.license || undefined,
    backends: row.backends ? JSON.parse(row.backends) : undefined,
    authors: row.authors ? JSON.parse(row.authors) : undefined,
    security: row.security ? JSON.parse(row.security) : undefined,
    package_urls: row.package_urls ? JSON.parse(row.package_urls) : undefined,
    aqua_link: row.aqua_link || undefined,
  }));

  return {
    tool_count: tools.length,
    tools,
  };
}

interface PaginatedToolRow extends ToolRow {
  downloads_30d: number;
}

/**
 * Load tools with pagination, filtering, and sorting from D1 database
 */
export async function loadToolsPaginated(
  analyticsDb: D1Database,
  params: ToolsQueryParams = {}
): Promise<PaginatedToolsResult> {
  const {
    page = 1,
    limit = 50,
    search,
    sort = 'downloads',
    backends,
  } = params;

  const offset = (page - 1) * limit;
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = new Date((now - 30 * 86400) * 1000).toISOString().split('T')[0];

  // Build WHERE conditions
  const conditions: string[] = ['t.latest_version IS NOT NULL'];
  const bindParams: (string | number)[] = [];

  if (search && search.trim()) {
    conditions.push("t.name LIKE '%' || ? || '%'");
    bindParams.push(search.trim().toLowerCase());
  }

  // Backend filter - check if any backend in the JSON array starts with the backend type
  if (backends && backends.length > 0) {
    const backendConditions = backends.map(() => "t.backends LIKE '%' || ? || ':%'").join(' OR ');
    conditions.push(`(${backendConditions})`);
    bindParams.push(...backends);
  }

  const whereClause = conditions.join(' AND ');

  // Build ORDER BY clause
  let orderClause: string;
  switch (sort) {
    case 'name':
      orderClause = 't.name ASC';
      break;
    case 'updated':
      orderClause = 't.last_updated DESC NULLS LAST';
      break;
    case 'downloads':
    default:
      orderClause = 'downloads_30d DESC, t.name ASC';
      break;
  }

  // Main query with CTE for downloads
  const mainQuery = `
    WITH downloads_30d AS (
      SELECT tool_id, SUM(downloads) as downloads_30d
      FROM daily_tool_stats
      WHERE date >= ?
      GROUP BY tool_id
    )
    SELECT
      t.name,
      t.latest_version,
      t.latest_stable_version,
      t.version_count,
      t.last_updated,
      t.description,
      t.github,
      t.homepage,
      t.repo_url,
      t.license,
      t.backends,
      t.authors,
      t.security,
      t.package_urls,
      t.aqua_link,
      COALESCE(d.downloads_30d, 0) as downloads_30d
    FROM tools t
    LEFT JOIN downloads_30d d ON d.tool_id = t.id
    WHERE ${whereClause}
    ORDER BY ${orderClause}
    LIMIT ? OFFSET ?
  `;

  // Count query
  const countQuery = `
    SELECT COUNT(*) as total
    FROM tools t
    WHERE ${whereClause}
  `;

  // Backend counts query (for filter chips - counts across ALL tools, not just current page)
  // Use subquery to filter valid JSON before json_each processes it
  const backendCountsQuery = `
    SELECT
      SUBSTR(
        json_extract(value, '$'),
        1,
        INSTR(json_extract(value, '$') || ':', ':') - 1
      ) as backend_type,
      COUNT(DISTINCT name) as count
    FROM (
      SELECT name, backends
      FROM tools
      WHERE latest_version IS NOT NULL
        AND backends IS NOT NULL
        AND json_valid(backends)
    ) t, json_each(t.backends)
    GROUP BY backend_type
    ORDER BY count DESC
  `;

  // Execute queries
  const mainBindParams = [thirtyDaysAgo, ...bindParams, limit, offset];
  const countBindParams = [...bindParams];

  const [mainResults, countResult, backendCountsResults] = await Promise.all([
    analyticsDb.prepare(mainQuery).bind(...mainBindParams).all<PaginatedToolRow>(),
    analyticsDb.prepare(countQuery).bind(...countBindParams).first<{ total: number }>(),
    analyticsDb.prepare(backendCountsQuery).all<{ backend_type: string; count: number }>(),
  ]);

  const totalCount = countResult?.total ?? 0;
  const totalPages = Math.ceil(totalCount / limit);

  // Parse tool rows
  const tools: ToolMeta[] = (mainResults.results || []).map(row => ({
    name: row.name,
    latest_version: row.latest_version || '',
    latest_stable_version: row.latest_stable_version || undefined,
    version_count: row.version_count || 0,
    last_updated: row.last_updated,
    description: row.description || undefined,
    github: row.github || undefined,
    homepage: row.homepage || undefined,
    repo_url: row.repo_url || undefined,
    license: row.license || undefined,
    backends: row.backends ? JSON.parse(row.backends) : undefined,
    authors: row.authors ? JSON.parse(row.authors) : undefined,
    security: row.security ? JSON.parse(row.security) : undefined,
    package_urls: row.package_urls ? JSON.parse(row.package_urls) : undefined,
    aqua_link: row.aqua_link || undefined,
  }));

  // Build downloads map
  const downloads: Record<string, number> = {};
  for (const row of mainResults.results || []) {
    downloads[row.name] = row.downloads_30d;
  }

  // Build backend counts map
  const backendCounts: Record<string, number> = {};
  for (const row of backendCountsResults.results || []) {
    if (row.backend_type) {
      backendCounts[row.backend_type] = row.count;
    }
  }

  return {
    tools,
    downloads,
    total_count: totalCount,
    page,
    limit,
    total_pages: totalPages,
    backendCounts,
  };
}
