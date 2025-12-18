import type { APIRoute } from 'astro';
import { getFromR2 } from '../lib/r2-data';

// Legacy endpoint: GET /tools.json - serves tools manifest
export const GET: APIRoute = async ({ locals }) => {
  try {
    const runtime = locals.runtime;
    const bucket = runtime.env.DATA_BUCKET;

    const data = await getFromR2(bucket, 'tools/tools.json');

    if (!data) {
      return new Response('tools.json not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return new Response(data.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600',
      },
    });
  } catch (error) {
    console.error('Error fetching tools.json from R2:', error);
    return new Response('Failed to fetch tools.json', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
};
