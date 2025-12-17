import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { setupAnalytics } from '../../../../../../src/analytics';

export const GET: APIRoute = async ({ params, locals }) => {
  try {
    const { tool } = params;
    if (!tool) {
      return new Response(JSON.stringify({ error: 'Tool name required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const runtime = locals.runtime;
    const db = drizzle(runtime.env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const stats = await analytics.getToolGrowth(tool);

    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (error) {
    console.error('Get tool growth error:', error);
    return new Response(JSON.stringify({ error: 'Failed to get tool growth' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
