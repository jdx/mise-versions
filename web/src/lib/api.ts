// Shared API utilities

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export const CACHE_CONTROL = {
  STATIC: 'public, max-age=600, stale-while-revalidate=86400', // 10 min + 1 day stale
  API: 'public, max-age=600, stale-while-revalidate=86400', // 10 min + 1 day stale
} as const;

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

export function cachedJsonResponse(data: unknown, cacheControl: string, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
    },
  });
}

export function errorResponse(message: string, status = 400) {
  return new Response(message, {
    status,
    headers: CORS_HEADERS,
  });
}
