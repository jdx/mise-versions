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

const BATCH_SIZE = 100; // D1 batch limit

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

  const d1 = runtime.env.ANALYTICS_DB;
  const db = drizzle(d1);

  // Run migrations to ensure schema is up to date
  await runAnalyticsMigrations(db);

  // Step 1: Get all tool names we need
  const toolNames = body.tools.map(t => t.tool).filter(Boolean);

  // Step 2: Get existing tool IDs in one query
  const placeholders = toolNames.map(() => '?').join(',');
  const existingTools = await d1.prepare(
    `SELECT id, name FROM tools WHERE name IN (${placeholders})`
  ).bind(...toolNames).all<{ id: number; name: string }>();

  const toolIdMap = new Map<string, number>();
  for (const row of existingTools.results) {
    toolIdMap.set(row.name, row.id);
  }

  // Step 3: Create missing tools
  const missingTools = toolNames.filter(name => !toolIdMap.has(name));
  if (missingTools.length > 0) {
    // Insert missing tools in batches
    for (let i = 0; i < missingTools.length; i += BATCH_SIZE) {
      const batch = missingTools.slice(i, i + BATCH_SIZE);
      const statements = batch.map(name =>
        d1.prepare('INSERT OR IGNORE INTO tools (name) VALUES (?)').bind(name)
      );
      await d1.batch(statements);
    }

    // Fetch IDs for newly created tools
    const newTools = await d1.prepare(
      `SELECT id, name FROM tools WHERE name IN (${missingTools.map(() => '?').join(',')})`
    ).bind(...missingTools).all<{ id: number; name: string }>();

    for (const row of newTools.results) {
      toolIdMap.set(row.name, row.id);
    }
  }

  let toolsProcessed = 0;
  let versionsUpserted = 0;
  let errors = 0;

  // Step 4: Batch upsert versions for all tools
  const allVersionStatements: D1PreparedStatement[] = [];

  for (const toolData of body.tools) {
    if (!toolData.tool || !Array.isArray(toolData.versions)) {
      errors++;
      continue;
    }

    const toolId = toolIdMap.get(toolData.tool);
    if (!toolId) {
      console.error(`Tool ID not found for ${toolData.tool}`);
      errors++;
      continue;
    }

    for (const v of toolData.versions) {
      if (!v.version) continue;

      allVersionStatements.push(
        d1.prepare(`
          INSERT INTO versions (tool_id, version, created_at, release_url)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(tool_id, version) DO UPDATE SET
            created_at = COALESCE(excluded.created_at, versions.created_at),
            release_url = COALESCE(excluded.release_url, versions.release_url)
        `).bind(toolId, v.version, v.created_at || null, v.release_url || null)
      );
    }

    toolsProcessed++;
  }

  // Execute version upserts in batches
  for (let i = 0; i < allVersionStatements.length; i += BATCH_SIZE) {
    const batch = allVersionStatements.slice(i, i + BATCH_SIZE);
    try {
      await d1.batch(batch);
      versionsUpserted += batch.length;
    } catch (e) {
      console.error(`Failed to upsert batch starting at ${i}:`, e);
      errors += batch.length;
    }
  }

  return jsonResponse({
    success: true,
    tools_processed: toolsProcessed,
    versions_upserted: versionsUpserted,
    errors,
  });
};
