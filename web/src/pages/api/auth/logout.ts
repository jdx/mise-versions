import type { APIRoute } from 'astro';
import { clearAuthCookie } from '../../../lib/auth';

// GET/POST /api/auth/logout - Clear auth cookie and log out
export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get('return_to') || '/';

  return new Response(null, {
    status: 302,
    headers: {
      'Location': returnTo,
      'Set-Cookie': clearAuthCookie(),
    },
  });
};

export const POST: APIRoute = GET;
