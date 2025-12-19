import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';
import { getAuthCookie } from '../../../lib/auth';
import { jsonResponse, errorResponse } from '../../../lib/api';
import { isAdmin } from '../../../lib/admin';

// GET /api/admin/table-counts - Get row counts for all D1 tables
export const GET: APIRoute = async ({ request, locals }) => {
  const runtime = locals.runtime;
  const auth = await getAuthCookie(request, runtime.env.API_SECRET);

  if (!auth || !isAdmin(auth.username)) {
    return errorResponse('Unauthorized', 401);
  }

  const db = drizzle(runtime.env.ANALYTICS_DB);

  // List of all tables to count
  const tables = [
    'tools',
    'backends',
    'platforms',
    'downloads',
    'downloads_daily',
    'daily_stats',
    'daily_tool_stats',
    'daily_backend_stats',
    'version_requests',
    'daily_version_stats',
    'versions',
  ];

  const counts: Record<string, number> = {};

  for (const table of tables) {
    try {
      const result = await db.get<{ count: number }>(
        sql.raw(`SELECT COUNT(*) as count FROM ${table}`)
      );
      counts[table] = result?.count ?? 0;
    } catch {
      // Table might not exist
      counts[table] = -1;
    }
  }

  return jsonResponse({ counts });
};
