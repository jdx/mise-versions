import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { setupAnalytics } from '../../../../src/analytics';
import { formatCount, generateBadgeSvg, svgResponse } from '../../lib/badge';

// GET /badge/:tool - Total downloads badge
export const GET: APIRoute = async ({ params, locals }) => {
  const tool = params.tool!.replace(/\.svg$/, ''); // Strip .svg extension if present

  try {
    const runtime = locals.runtime;
    const db = drizzle(runtime.env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const stats = await analytics.getDownloadStats(tool);
    const count = stats.total || 0;

    const svg = generateBadgeSvg(
      'mise',
      count > 0 ? `${formatCount(count)} downloads` : 'no downloads',
      '#555',
      count > 0 ? '#4c1' : '#9f9f9f'
    );

    return svgResponse(svg);
  } catch (error) {
    console.error('Badge error:', error);
    const svg = generateBadgeSvg('mise', 'error', '#555', '#e05d44');
    return svgResponse(svg, 60); // Short cache on error
  }
};
