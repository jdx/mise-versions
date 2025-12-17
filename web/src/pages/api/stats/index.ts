import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { setupDatabase } from '../../../../../src/database';
import { jsonResponse, requireApiAuth } from '../../../lib/api';

// GET /api/stats - Token statistics (admin)
export const GET: APIRoute = async ({ request, locals }) => {
  const runtime = locals.runtime;

  const authError = requireApiAuth(request, runtime.env.API_SECRET);
  if (authError) return authError;

  const db = drizzle(runtime.env.DB);
  const database = setupDatabase(db);
  const stats = await database.getTokenStats();

  return jsonResponse(stats);
};
