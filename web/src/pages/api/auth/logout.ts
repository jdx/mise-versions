import type { APIRoute } from 'astro';
import { clearAuthCookie } from '../../../lib/auth';

// GET/POST /api/auth/logout - Clear auth cookie and log out
export const GET: APIRoute = async () => {
  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': clearAuthCookie(),
    },
  });
};

export const POST: APIRoute = GET;
