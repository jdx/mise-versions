import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';
import { jsonResponse, errorResponse } from '../../../../lib/api';
import { runAnalyticsMigrations } from '../../../../../../src/analytics';

interface ToolMetadata {
  name: string;
  latest_version?: string;
  latest_stable_version?: string;
  version_count?: number;
  last_updated?: string;
  description?: string;
  github?: string;
  homepage?: string;
  repo_url?: string;
  license?: string;
  backends?: string[];
  authors?: string[];
  security?: string[];
  package_urls?: Record<string, string>;
  aqua_link?: string;
}

// POST /api/admin/tools/sync - Sync tool metadata from CI
export const POST: APIRoute = async ({ request, locals }) => {
  const runtime = locals.runtime;

  let body: { tools: ToolMetadata[] };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!Array.isArray(body.tools) || body.tools.length === 0) {
    return errorResponse('tools must be a non-empty array', 400);
  }

  const db = drizzle(runtime.env.ANALYTICS_DB);

  // Run migrations to ensure schema is up to date
  await runAnalyticsMigrations(db);

  const now = new Date().toISOString();

  let upserted = 0;
  let errors = 0;
  const failedTools: Array<{ name: string; error: string }> = [];

  // Process tools using INSERT ... ON CONFLICT DO UPDATE (single query per tool)
  for (const tool of body.tools) {
    if (!tool.name) {
      errors++;
      failedTools.push({ name: '(unnamed)', error: 'Missing name' });
      continue;
    }

    try {
      const backendsJson = tool.backends ? JSON.stringify(tool.backends) : null;
      const authorsJson = tool.authors ? JSON.stringify(tool.authors) : null;
      const securityJson = tool.security ? JSON.stringify(tool.security) : null;
      const packageUrlsJson = tool.package_urls ? JSON.stringify(tool.package_urls) : null;

      // Use INSERT ... ON CONFLICT DO UPDATE (upsert) - single query instead of SELECT + UPDATE/INSERT
      await db.run(sql`
        INSERT INTO tools (
          name, latest_version, latest_stable_version, version_count,
          last_updated, description, github, homepage, repo_url, license,
          backends, authors, security, package_urls, aqua_link, metadata_updated_at
        ) VALUES (
          ${tool.name},
          ${tool.latest_version || null},
          ${tool.latest_stable_version || null},
          ${tool.version_count || 0},
          ${tool.last_updated || null},
          ${tool.description || null},
          ${tool.github || null},
          ${tool.homepage || null},
          ${tool.repo_url || null},
          ${tool.license || null},
          ${backendsJson},
          ${authorsJson},
          ${securityJson},
          ${packageUrlsJson},
          ${tool.aqua_link || null},
          ${now}
        )
        ON CONFLICT(name) DO UPDATE SET
          latest_version = excluded.latest_version,
          latest_stable_version = excluded.latest_stable_version,
          version_count = excluded.version_count,
          last_updated = excluded.last_updated,
          description = excluded.description,
          github = excluded.github,
          homepage = excluded.homepage,
          repo_url = excluded.repo_url,
          license = excluded.license,
          backends = excluded.backends,
          authors = excluded.authors,
          security = excluded.security,
          package_urls = excluded.package_urls,
          aqua_link = excluded.aqua_link,
          metadata_updated_at = excluded.metadata_updated_at
      `);
      upserted++;
    } catch (e: any) {
      const errorMsg = e?.message || String(e);
      console.error(`Failed to sync tool ${tool.name}:`, errorMsg);
      errors++;
      failedTools.push({ name: tool.name, error: errorMsg });
    }
  }

  return jsonResponse({
    success: true,
    upserted,
    errors,
    total: body.tools.length,
    failed_tools: failedTools.length > 0 ? failedTools : undefined,
  });
};
