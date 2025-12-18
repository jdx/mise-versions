import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { setupDatabase } from '../../../../../src/database';
import { jsonResponse } from '../../../lib/api';
import { requireAdminAuth } from '../../../lib/admin';

// GET /api/admin/tokens - Get token pool information (admin only)
export const GET: APIRoute = async ({ request, locals }) => {
  const runtime = locals.runtime;

  // Check admin auth (cookie-based)
  const authResult = await requireAdminAuth(request, runtime.env.API_SECRET);
  if (authResult instanceof Response) {
    return authResult;
  }

  const db = drizzle(runtime.env.DB);
  const database = setupDatabase(db);

  // Get token statistics
  const stats = await database.getTokenStats();

  // Get all active tokens with details (excluding actual token values)
  const allTokens = await database.getAllTokens();
  const tokenDetails = allTokens.map((t) => ({
    id: t.id,
    user_id: t.user_id,
    user_name: t.user_name,
    usage_count: t.usage_count,
    last_used: t.last_used,
    is_active: t.is_active,
    rate_limited_at: t.rate_limited_at,
    expires_at: t.expires_at,
    last_validated: t.last_validated,
    scopes: t.scopes ? JSON.parse(t.scopes) : null,
    created_at: t.created_at,
  }));

  // Get expiring tokens
  const expiringTokens = await database.getExpiringTokens();
  const expiringSoon = expiringTokens.map((t) => ({
    id: t.id,
    user_name: t.user_name,
    expires_at: t.expires_at,
  }));

  return jsonResponse({
    stats: {
      active: stats.active,
      total: stats.total,
    },
    tokens: tokenDetails,
    expiringSoon,
  });
};
