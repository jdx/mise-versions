import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { runAnalyticsMigrations } from '../../../../../src/analytics';
import { jsonResponse } from '../../../lib/api';

// POST /api/admin/migrate - Run database migrations
export const POST: APIRoute = async ({ locals }) => {
  const runtime = locals.runtime;

  const db = drizzle(runtime.env.ANALYTICS_DB);
  await runAnalyticsMigrations(db);

  return jsonResponse({ success: true, message: 'Migrations completed' });
};
