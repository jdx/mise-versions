// Admin authentication utilities

import { getAuthCookie } from './auth';
import { errorResponse } from './api';

const ADMIN_USERNAME = 'jdx';

export async function requireAdminAuth(
  request: Request,
  apiSecret: string
): Promise<Response | { username: string }> {
  const auth = await getAuthCookie(request, apiSecret);

  if (!auth) {
    return errorResponse('Not authenticated', 401);
  }

  if (auth.username !== ADMIN_USERNAME) {
    return errorResponse('Forbidden: Admin access required', 403);
  }

  return auth;
}

export function isAdmin(username: string | null): boolean {
  return username === ADMIN_USERNAME;
}
