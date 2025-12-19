import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';
import { jsonResponse, errorResponse, requireApiAuth } from '../../../../lib/api';

interface MetadataEntry {
  name: string;
  license?: string | null;
  homepage?: string | null;
  description?: string | null;
  authors?: string[] | null;
}

interface SyncRequest {
  metadata: MetadataEntry[];
}

// POST /api/admin/metadata/sync - Sync tool metadata to D1
export const POST: APIRoute = async ({ request, locals }) => {
  const authError = requireApiAuth(request, locals);
  if (authError) return authError;

  try {
    const body = await request.json() as SyncRequest;

    if (!body.metadata || !Array.isArray(body.metadata)) {
      return errorResponse('Invalid request: metadata array required', 400);
    }

    const runtime = locals.runtime;
    const db = drizzle(runtime.env.ANALYTICS_DB);

    let updated = 0;
    let errors = 0;
    const failedTools: Array<{ name: string; error: string }> = [];

    for (const entry of body.metadata) {
      if (!entry.name) {
        errors++;
        continue;
      }

      try {
        const authorsJson = entry.authors ? JSON.stringify(entry.authors) : null;

        // Update only metadata fields, don't touch version info
        await db.run(sql`
          UPDATE tools SET
            license = COALESCE(${entry.license || null}, license),
            homepage = COALESCE(${entry.homepage || null}, homepage),
            description = COALESCE(${entry.description || null}, description),
            authors = COALESCE(${authorsJson}, authors),
            metadata_updated_at = ${new Date().toISOString()}
          WHERE name = ${entry.name}
        `);

        updated++;
      } catch (e) {
        errors++;
        failedTools.push({
          name: entry.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return jsonResponse({
      success: true,
      updated,
      errors,
      total: body.metadata.length,
      failed_tools: failedTools.slice(0, 10),
    });
  } catch (e) {
    console.error('Metadata sync error:', e);
    return errorResponse(
      e instanceof Error ? e.message : 'Metadata sync failed',
      500
    );
  }
};
