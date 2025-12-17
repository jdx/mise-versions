import type { APIRoute } from 'astro';
import { CORS_HEADERS, CACHE_CONTROL } from '../../lib/api';

// GET /data/* - Proxy to mise-versions.jdx.dev (GitHub Pages)
export const GET: APIRoute = async ({ params }) => {
  const dataPath = params.path || '';
  const dataUrl = `https://mise-versions.jdx.dev/${dataPath}`;
  const response = await fetch(dataUrl);

  // Return with CORS headers, only cache successful responses
  const headers: Record<string, string> = {
    ...Object.fromEntries(response.headers),
    ...CORS_HEADERS,
  };
  if (response.ok) {
    headers['Cache-Control'] = CACHE_CONTROL.STATIC;
  }
  return new Response(response.body, {
    status: response.status,
    headers,
  });
};
