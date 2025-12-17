import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { runMigrations } from '../../../../../src/migrations';
import { runAnalyticsMigrations, setupAnalytics } from '../../../../../src/analytics';
import { jsonResponse, errorResponse } from '../../../lib/api';

// POST /api/admin/scheduled - Run scheduled tasks (called by cron)
// This endpoint handles the daily aggregation tasks
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const runtime = locals.runtime;

    // Verify admin secret
    const authHeader = request.headers.get('Authorization');
    const expectedAuth = `Bearer ${runtime.env.API_SECRET}`;
    if (authHeader !== expectedAuth) {
      return errorResponse('Unauthorized', 401);
    }

    console.log('Running scheduled tasks...');

    // Run migrations first
    const db = drizzle(runtime.env.DB);
    await runMigrations(db);

    const analyticsDb = drizzle(runtime.env.ANALYTICS_DB);
    await runAnalyticsMigrations(analyticsDb);

    const analytics = setupAnalytics(analyticsDb);

    // 1. Aggregate old data (data older than 90 days)
    const aggregateResult = await analytics.aggregateOldData();
    console.log(
      `Aggregation complete: ${aggregateResult.aggregated} groups aggregated, ${aggregateResult.deleted} rows deleted`
    );

    // 2. Populate rollup tables for yesterday (and today so far)
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    const todayStr = now.toISOString().split('T')[0];

    // Populate yesterday's full data
    const yesterdayResult = await analytics.populateRollupTables(yesterdayStr, runtime.env.ANALYTICS_DB);
    console.log(
      `Rollup tables populated for ${yesterdayStr}: ${yesterdayResult.toolStats} tools, ${yesterdayResult.backendStats} backends`
    );

    // Also update today's partial data
    const todayResult = await analytics.populateRollupTables(todayStr, runtime.env.ANALYTICS_DB);
    console.log(
      `Rollup tables updated for ${todayStr}: ${todayResult.toolStats} tools, ${todayResult.backendStats} backends`
    );

    return jsonResponse({
      success: true,
      aggregation: {
        aggregated: aggregateResult.aggregated,
        deleted: aggregateResult.deleted,
      },
      rollups: {
        yesterday: {
          date: yesterdayStr,
          toolStats: yesterdayResult.toolStats,
          backendStats: yesterdayResult.backendStats,
        },
        today: {
          date: todayStr,
          toolStats: todayResult.toolStats,
          backendStats: todayResult.backendStats,
        },
      },
    });
  } catch (error) {
    console.error('Scheduled task error:', error);
    return errorResponse(`Failed to run scheduled tasks: ${error}`, 500);
  }
};
