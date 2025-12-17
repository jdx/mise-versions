import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { setupDatabase } from '../../../src/database';
import { getMigrationStatus } from '../../../src/migrations';
import { jsonResponse } from '../lib/api';

// GET /health - Health check with token statistics
export const GET: APIRoute = async ({ locals }) => {
  const runtime = locals.runtime;
  const db = drizzle(runtime.env.DB);
  const database = setupDatabase(db);

  const stats = await database.getTokenStats();
  const expiringTokens = await database.getExpiringTokens();
  const migrationStatus = await getMigrationStatus(db);

  return jsonResponse({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    tokens: stats,
    tokenTypes: {
      total: stats.total,
      active: stats.active,
    },
    expiringTokens: expiringTokens.length,
    migrations: migrationStatus,
  });
};
