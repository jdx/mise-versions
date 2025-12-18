import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { setupDatabase } from '../../../../../../src/database';
import { jsonResponse, errorResponse } from '../../../../lib/api';
import { requireAdminAuth } from '../../../../lib/admin';

// POST /api/admin/tokens/delete-batch - Delete multiple tokens by IDs (admin only)
export const POST: APIRoute = async ({ request, locals }) => {
  const runtime = locals.runtime;

  // Check admin auth (cookie-based)
  const authResult = await requireAdminAuth(request, runtime.env.API_SECRET);
  if (authResult instanceof Response) {
    return authResult;
  }

  let body: { ids: number[] };
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return errorResponse('ids must be a non-empty array', 400);
  }

  const db = drizzle(runtime.env.DB);
  const database = setupDatabase(db);

  const result = await database.deleteTokens(body.ids);

  return jsonResponse({ success: true, deleted: result.rowsAffected });
};
