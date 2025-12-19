import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';
import { jsonResponse, errorResponse } from '../../../lib/api';
import { requireAdminAuth } from '../../../lib/admin';

interface AsdfPrimaryTool {
  name: string;
  downloads_30d: number;
  asdf_backend: string;
}

// GET /api/admin/asdf-primary - Get asdf-primary tools ranked by download count
export const GET: APIRoute = async ({ request, locals }) => {
  const runtime = locals.runtime;

  // Check admin auth (cookie-based)
  const authResult = await requireAdminAuth(request, runtime.env.API_SECRET);
  if (authResult instanceof Response) {
    return authResult;
  }

  const db = drizzle(runtime.env.ANALYTICS_DB);

  try {
    // Get all tools with their backends and 30-day download counts
    // A tool is "asdf-primary" if its first backend starts with "asdf:"
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
    const startDate = new Date(thirtyDaysAgo * 1000).toISOString().split('T')[0];

    // First, get all tools with backends
    const toolsWithBackends = await db.all<{
      id: number;
      name: string;
      backends: string | null;
    }>(sql`
      SELECT id, name, backends
      FROM tools
      WHERE backends IS NOT NULL
    `);

    // Filter to asdf-primary tools (first backend starts with "asdf:")
    const asdfPrimaryTools: Array<{ id: number; name: string; asdf_backend: string }> = [];
    for (const tool of toolsWithBackends) {
      if (!tool.backends) continue;
      try {
        const backends = JSON.parse(tool.backends) as string[];
        if (backends.length > 0 && backends[0].startsWith('asdf:')) {
          asdfPrimaryTools.push({
            id: tool.id,
            name: tool.name,
            asdf_backend: backends[0],
          });
        }
      } catch {
        // Skip invalid JSON
      }
    }

    if (asdfPrimaryTools.length === 0) {
      return jsonResponse({ tools: [], total: 0 });
    }

    // Get 30-day download counts for these tools (batch to avoid D1 parameter limit)
    const toolIds = asdfPrimaryTools.map(t => t.id);
    const BATCH_SIZE = 99;
    const downloadCounts: Array<{ tool_id: number; downloads: number }> = [];

    for (let i = 0; i < toolIds.length; i += BATCH_SIZE) {
      const batch = toolIds.slice(i, i + BATCH_SIZE);
      const batchResults = await db.all<{ tool_id: number; downloads: number }>(sql`
        SELECT tool_id, SUM(downloads) as downloads
        FROM daily_tool_stats
        WHERE date >= ${startDate}
          AND tool_id IN (${sql.join(batch.map(id => sql`${id}`), sql`, `)})
        GROUP BY tool_id
      `);
      downloadCounts.push(...batchResults);
    }

    // Build map of tool_id -> downloads
    const downloadMap = new Map<number, number>();
    for (const row of downloadCounts) {
      downloadMap.set(row.tool_id, row.downloads);
    }

    // Combine and sort by download count
    const results: AsdfPrimaryTool[] = asdfPrimaryTools
      .map(tool => ({
        name: tool.name,
        downloads_30d: downloadMap.get(tool.id) || 0,
        asdf_backend: tool.asdf_backend,
      }))
      .sort((a, b) => b.downloads_30d - a.downloads_30d);

    return jsonResponse({
      tools: results,
      total: results.length,
      total_downloads: results.reduce((sum, t) => sum + t.downloads_30d, 0),
    });
  } catch (error: any) {
    console.error('Error fetching asdf-primary tools:', error);
    return errorResponse(`Failed to fetch asdf-primary tools: ${error.message}`, 500);
  }
};
