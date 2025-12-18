import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';
import { jsonResponse, errorResponse, requireApiAuth } from '../../../../lib/api';
import { runAnalyticsMigrations } from '../../../../../../src/analytics';

interface VersionData {
  version: string;
  created_at?: string | null;
  release_url?: string | null;
}

interface ToolVersions {
  tool: string;
  versions: VersionData[];
}

// POST /api/admin/versions/sync - Sync tool versions from CI
export const POST: APIRoute = async ({ request, locals }) => {
  const runtime = locals.runtime;

  // Check API auth (Bearer token for CI)
  const authError = requireApiAuth(request, runtime.env.API_SECRET);
  if (authError) {
    return authError;
  }

  let body: { tools: ToolVersions[] };
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

  let toolsProcessed = 0;
  let versionsUpserted = 0;
  let errors = 0;

  for (const toolData of body.tools) {
    if (!toolData.tool || !Array.isArray(toolData.versions)) {
      errors++;
      continue;
    }

    try {
      // Get or create tool_id
      const existing = await db.all(sql`
        SELECT id FROM tools WHERE name = ${toolData.tool}
      `);

      let toolId: number;
      if (existing.length > 0) {
        toolId = (existing[0] as { id: number }).id;
      } else {
        // Insert new tool
        await db.run(sql`
          INSERT INTO tools (name) VALUES (${toolData.tool})
        `);
        const inserted = await db.all(sql`
          SELECT id FROM tools WHERE name = ${toolData.tool}
        `);
        toolId = (inserted[0] as { id: number }).id;
      }

      // Upsert versions
      for (const v of toolData.versions) {
        if (!v.version) continue;

        try {
          await db.run(sql`
            INSERT INTO versions (tool_id, version, created_at, release_url)
            VALUES (${toolId}, ${v.version}, ${v.created_at || null}, ${v.release_url || null})
            ON CONFLICT(tool_id, version) DO UPDATE SET
              created_at = COALESCE(excluded.created_at, versions.created_at),
              release_url = COALESCE(excluded.release_url, versions.release_url)
          `);
          versionsUpserted++;
        } catch (e) {
          console.error(`Failed to upsert version ${v.version} for ${toolData.tool}:`, e);
          errors++;
        }
      }

      toolsProcessed++;
    } catch (e) {
      console.error(`Failed to sync versions for ${toolData.tool}:`, e);
      errors++;
    }
  }

  return jsonResponse({
    success: true,
    tools_processed: toolsProcessed,
    versions_upserted: versionsUpserted,
    errors,
  });
};
