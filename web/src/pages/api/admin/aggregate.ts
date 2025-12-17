import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { setupAnalytics } from '../../../../../src/analytics';
import { jsonResponse, errorResponse } from '../../../lib/api';

// POST /api/admin/aggregate - Aggregate old download data (requires auth)
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

    const result = await analytics.aggregateOldData();

    return jsonResponse({
      success: true,
      aggregated: result.aggregated,
      deleted: result.deleted,
    });
  } catch (error) {
    console.error('Aggregate error:', error);
    return errorResponse('Failed to aggregate data', 500);
  }
};
