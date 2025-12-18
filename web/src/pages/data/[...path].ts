import type { APIRoute } from 'astro';
import { CORS_HEADERS, CACHE_CONTROL } from '../../lib/api';
import { getFromR2 } from '../../lib/r2-data';

// GET /data/* - Serve files from R2 bucket
export const GET: APIRoute = async ({ params, locals }) => {
  const dataPath = params.path || '';

  if (!dataPath) {
    return new Response('Path required', {
      status: 400,
      headers: { 'Content-Type': 'text/plain', ...CORS_HEADERS },
    });
  }

  // Validate path (alphanumeric, hyphens, underscores, slashes, dots)
  if (!/^[\w\-\/.]+$/.test(dataPath)) {
    return new Response('Invalid path', {
      status: 400,
      headers: { 'Content-Type': 'text/plain', ...CORS_HEADERS },
    });
  }

  try {
    const runtime = locals.runtime;
    const bucket = runtime.env.DATA_BUCKET;

    const data = await getFromR2(bucket, dataPath);

    if (!data) {
      return new Response(`File not found: ${dataPath}`, {
        status: 404,
        headers: { 'Content-Type': 'text/plain', ...CORS_HEADERS },
      });
    }

    return new Response(data.body, {
      status: 200,
      headers: {
        'Content-Type': data.contentType,
        'Cache-Control': CACHE_CONTROL.STATIC,
        ...CORS_HEADERS,
      },
    });
  } catch (error) {
    console.error('Error fetching from R2:', error);
    return new Response('Failed to fetch data', {
      status: 500,
      headers: { 'Content-Type': 'text/plain', ...CORS_HEADERS },
    });
  }
};
