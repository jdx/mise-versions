import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { setupAnalytics } from '../../../../../src/analytics';
import { formatCount, generateBadgeSvg, svgResponse } from '../../../lib/badge';

// GET /badge/:tool/30d - 30-day downloads badge
export const GET: APIRoute = async ({ params, locals }) => {
  const tool = params.tool!;

  try {
    const runtime = locals.runtime;
    const db = drizzle(runtime.env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const counts = await analytics.getAll30DayDownloads();
    const count = counts[tool] || 0;

    const svg = generateBadgeSvg(
      'mise/30d',
      count > 0 ? `${formatCount(count)} downloads` : 'no downloads',
      '#555',
      count > 0 ? '#007ec6' : '#9f9f9f'
    );

    return svgResponse(svg);
  } catch (error) {
    console.error('Badge 30d error:', error);
    const svg = generateBadgeSvg('mise/30d', 'error', '#555', '#e05d44');
    return svgResponse(svg, 60);
  }
};
