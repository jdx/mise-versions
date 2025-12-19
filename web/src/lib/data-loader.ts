// Centralized data loading from D1
import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';

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
