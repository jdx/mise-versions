import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';
import { jsonResponse, errorResponse, requireApiAuth } from '../../../../lib/api';
import { runAnalyticsMigrations, setupAnalytics } from '../../../../../../src/analytics';

interface VersionData {
  version: string;
  created_at?: string | null;
  release_url?: string | null;
  sort_order?: number | null;
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
  const analytics = setupAnalytics(db);

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

  // Step 4: Get existing version counts per tool (before sync)
  const toolIds = [...toolIdMap.values()];
  const beforeCounts = new Map<number, number>();
  if (toolIds.length > 0) {
    const countResults = await d1.prepare(
      `SELECT tool_id, COUNT(*) as count FROM versions WHERE tool_id IN (${toolIds.map(() => '?').join(',')}) GROUP BY tool_id`
    ).bind(...toolIds).all<{ tool_id: number; count: number }>();
    for (const row of countResults.results) {
      beforeCounts.set(row.tool_id, row.count);
    }
  }

  let toolsProcessed = 0;
  let versionsUpserted = 0;
  let errors = 0;

  // Step 5: Batch upsert versions for all tools
  const allVersionStatements: D1PreparedStatement[] = [];
  const toolIdToName = new Map<number, string>();

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

    toolIdToName.set(toolId, toolData.tool);

    for (const v of toolData.versions) {
      if (!v.version) continue;

      allVersionStatements.push(
        d1.prepare(`
          INSERT INTO versions (tool_id, version, created_at, release_url, from_mise, sort_order)
          VALUES (?, ?, ?, ?, 1, ?)
          ON CONFLICT(tool_id, version) DO UPDATE SET
            created_at = COALESCE(excluded.created_at, versions.created_at),
            release_url = COALESCE(excluded.release_url, versions.release_url),
            from_mise = 1,
            sort_order = COALESCE(excluded.sort_order, versions.sort_order)
        `).bind(toolId, v.version, v.created_at || null, v.release_url || null, v.sort_order ?? null)
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

  // Step 6: Clean up stale versions (from_mise=1 versions not in the incoming data)
  // This removes phantom versions that no longer exist in mise ls-remote
  let versionsDeleted = 0;
  for (const toolData of body.tools) {
    if (!toolData.tool || !Array.isArray(toolData.versions)) continue;

    const toolId = toolIdMap.get(toolData.tool);
    if (!toolId) continue;

    const incomingVersions = new Set(
      toolData.versions
        .map(v => v.version)
        .filter((v): v is string => Boolean(v))
    );

    if (incomingVersions.size === 0) continue;

    // Get all existing from_mise=1 versions for this tool
    const existingVersions = await d1.prepare(
      'SELECT version FROM versions WHERE tool_id = ? AND from_mise = 1'
    ).bind(toolId).all<{ version: string }>();

    // Find versions to delete (exist in DB but not in incoming)
    const versionsToDelete = existingVersions.results
      .map(r => r.version)
      .filter(v => !incomingVersions.has(v));

    if (versionsToDelete.length === 0) continue;

    // Delete in batches to avoid parameter limits
    for (let i = 0; i < versionsToDelete.length; i += BATCH_SIZE) {
      const batch = versionsToDelete.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => '?').join(',');
      try {
        const result = await d1.prepare(`
          DELETE FROM versions
          WHERE tool_id = ? AND from_mise = 1 AND version IN (${placeholders})
        `).bind(toolId, ...batch).run();
        versionsDeleted += result.meta.changes ?? 0;
      } catch (e) {
        console.error(`Failed to clean up stale versions for ${toolData.tool}:`, e);
      }
    }
  }

  if (versionsDeleted > 0) {
    console.log(`Cleaned up ${versionsDeleted} stale versions`);
  }

  // Step 7: Get new version counts and record updates
  let newVersionsTotal = 0;
  if (toolIds.length > 0) {
    const afterCounts = await d1.prepare(
      `SELECT tool_id, COUNT(*) as count FROM versions WHERE tool_id IN (${toolIds.map(() => '?').join(',')}) GROUP BY tool_id`
    ).bind(...toolIds).all<{ tool_id: number; count: number }>();

    for (const row of afterCounts.results) {
      const beforeCount = beforeCounts.get(row.tool_id) ?? 0;
      const newVersions = row.count - beforeCount;
      if (newVersions > 0) {
        newVersionsTotal += newVersions;
        // Record the update for stats tracking
        try {
          await analytics.recordVersionUpdates(row.tool_id, newVersions);
        } catch (e) {
          console.error(`Failed to record version updates for tool ${row.tool_id}:`, e);
        }
      }
    }
  }

  return jsonResponse({
    success: true,
    tools_processed: toolsProcessed,
    versions_upserted: versionsUpserted,
    versions_deleted: versionsDeleted,
    new_versions: newVersionsTotal,
    errors,
  });
};
