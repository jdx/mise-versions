import type { APIRoute } from 'astro';
import { loadToolsJson } from '../lib/data-loader';

// Legacy endpoint: GET /tools.json - serves tools manifest from D1
export const GET: APIRoute = async ({ locals }) => {
  try {
    const runtime = locals.runtime;
    const toolsData = await loadToolsJson(runtime.env.ANALYTICS_DB);

    if (!toolsData) {
      return new Response('tools.json not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return new Response(JSON.stringify(toolsData), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600',
      },
    });
  } catch (error) {
    console.error('Error fetching tools from D1:', error);
    return new Response('Failed to fetch tools.json', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
};
