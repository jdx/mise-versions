import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { setupAnalytics } from '../../../../../src/analytics';
import { formatCount, generateBadgeSvg, svgResponse } from '../../../lib/badge';

// GET /badge/:tool/week - 7-day downloads badge
export const GET: APIRoute = async ({ params, locals }) => {
  const tool = params.tool!;

  try {
    const runtime = locals.runtime;
    const db = drizzle(runtime.env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const stats = await analytics.getDownloadStats(tool);
    // Sum last 7 days from daily stats
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().split('T')[0];

    let count = 0;
    for (const day of stats.daily || []) {
      if (day.date >= sevenDaysAgoStr) {
        count += day.count;
      }
    }

    const svg = generateBadgeSvg(
      'mise/week',
      count > 0 ? `${formatCount(count)} downloads` : 'no downloads',
      '#555',
      count > 0 ? '#97ca00' : '#9f9f9f'
    );

    return svgResponse(svg);
  } catch (error) {
    console.error('Badge week error:', error);
    const svg = generateBadgeSvg('mise/week', 'error', '#555', '#e05d44');
    return svgResponse(svg, 60);
  }
};
