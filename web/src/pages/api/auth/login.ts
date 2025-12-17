import type { APIRoute } from 'astro';
import { setOAuthStateCookie } from '../../../lib/auth';

// GET /api/auth/login - Redirect to GitHub OAuth
export const GET: APIRoute = async ({ request, locals, redirect }) => {
  const runtime = locals.runtime;
  const url = new URL(request.url);

  const redirectUri = `${url.origin}/api/auth/callback`;
  const scope = 'public_repo';
  const state = crypto.randomUUID();

  const githubAuthUrl = new URL('https://github.com/login/oauth/authorize');
  githubAuthUrl.searchParams.set('client_id', runtime.env.GITHUB_CLIENT_ID);
  githubAuthUrl.searchParams.set('redirect_uri', redirectUri);
  githubAuthUrl.searchParams.set('scope', scope);
  githubAuthUrl.searchParams.set('state', state);

  // Store state in cookie for CSRF validation in callback
  return new Response(null, {
    status: 302,
    headers: {
      'Location': githubAuthUrl.toString(),
      'Set-Cookie': setOAuthStateCookie(state),
    },
  });
};
