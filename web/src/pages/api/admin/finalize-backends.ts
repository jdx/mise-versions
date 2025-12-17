import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { setupAnalytics } from '../../../../../src/analytics';
import { jsonResponse, errorResponse } from '../../../lib/api';

// POST /api/admin/finalize-backends - Make backend_id NOT NULL (requires auth)
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const runtime = locals.runtime;

    // Verify admin secret
    const authHeader = request.headers.get('Authorization');
    const expectedAuth = `Bearer ${runtime.env.API_SECRET}`;
    if (authHeader !== expectedAuth) {
      return errorResponse('Unauthorized', 401);
    }

    const db = drizzle(runtime.env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    await analytics.makeBackendIdNotNull();

    return jsonResponse({
      success: true,
      message: 'backend_id is now NOT NULL',
    });
  } catch (error) {
    console.error('Finalize backends error:', error);
    return errorResponse(`Failed to finalize backends: ${error}`, 500);
  }
};
