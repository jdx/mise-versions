import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { setupAnalytics } from '../../../../../../src/analytics';

export const GET: APIRoute = async ({ params, request, locals }) => {
  const { tool } = params;

  if (!tool) {
    return new Response(JSON.stringify({ error: 'Tool parameter required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const days = parseInt(url.searchParams.get('days') || '30', 10);

  try {
    const runtime = locals.runtime;
    const db = drizzle(runtime.env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const data = await analytics.getVersionTrends(tool, days);

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (e) {
    console.error('Failed to get version trends:', e);
    return new Response(JSON.stringify({ error: 'Failed to get version trends' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
