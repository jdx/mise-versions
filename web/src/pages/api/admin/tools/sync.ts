import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';
import { jsonResponse, errorResponse, requireApiAuth } from '../../../../lib/api';
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

  // Check API auth (Bearer token for CI)
  const authError = requireApiAuth(request, runtime.env.API_SECRET);
  if (authError) {
    return authError;
  }

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

  let inserted = 0;
  let updated = 0;
  let errors = 0;

  // Process tools in batches
  const BATCH_SIZE = 50;
  for (let i = 0; i < body.tools.length; i += BATCH_SIZE) {
    const batch = body.tools.slice(i, i + BATCH_SIZE);

    for (const tool of batch) {
      if (!tool.name) {
        errors++;
        continue;
      }

      try {
        // Check if tool exists
        const existing = await db.all(sql`
          SELECT id FROM tools WHERE name = ${tool.name}
        `);

        const backendsJson = tool.backends ? JSON.stringify(tool.backends) : null;
        const authorsJson = tool.authors ? JSON.stringify(tool.authors) : null;
        const securityJson = tool.security ? JSON.stringify(tool.security) : null;
        const packageUrlsJson = tool.package_urls ? JSON.stringify(tool.package_urls) : null;

        if (existing.length > 0) {
          // Update existing tool
          await db.run(sql`
            UPDATE tools SET
              latest_version = ${tool.latest_version || null},
              latest_stable_version = ${tool.latest_stable_version || null},
              version_count = ${tool.version_count || 0},
              last_updated = ${tool.last_updated || null},
              description = ${tool.description || null},
              github = ${tool.github || null},
              homepage = ${tool.homepage || null},
              repo_url = ${tool.repo_url || null},
              license = ${tool.license || null},
              backends = ${backendsJson},
              authors = ${authorsJson},
              security = ${securityJson},
              package_urls = ${packageUrlsJson},
              aqua_link = ${tool.aqua_link || null},
              metadata_updated_at = ${now}
            WHERE name = ${tool.name}
          `);
          updated++;
        } else {
          // Insert new tool
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
          `);
          inserted++;
        }
      } catch (e) {
        console.error(`Failed to sync tool ${tool.name}:`, e);
        errors++;
      }
    }
  }

  return jsonResponse({
    success: true,
    inserted,
    updated,
    errors,
    total: body.tools.length,
  });
};
