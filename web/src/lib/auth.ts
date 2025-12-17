// Auth utilities for cookie-based authentication

export const AUTH_COOKIE_NAME = 'mise_auth';
export const OAUTH_STATE_COOKIE_NAME = 'mise_oauth_state';

// HMAC signing for secure cookies
async function signData(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function verifySignature(
  data: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const expectedSignature = await signData(data, secret);
  // Constant-time comparison to prevent timing attacks
  if (signature.length !== expectedSignature.length) return false;
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
  }
  return result === 0;
}

export async function getAuthCookie(
  request: Request,
  secret: string
): Promise<{ username: string } | null> {
  const cookies = request.headers.get('Cookie') || '';
  const match = cookies.match(new RegExp(`${AUTH_COOKIE_NAME}=([^;]+)`));
  if (!match) return null;

  try {
    const decoded = decodeURIComponent(match[1]);
    const [data, signature] = decoded.split('.');
    if (!data || !signature) return null;

    const isValid = await verifySignature(data, signature, secret);
    if (!isValid) return null;

    return JSON.parse(atob(data));
  } catch {
    return null;
  }
}

export async function setAuthCookie(
  username: string,
  secret: string
): Promise<string> {
  const data = btoa(JSON.stringify({ username }));
  const signature = await signData(data, secret);
  const value = encodeURIComponent(`${data}.${signature}`);
  // Cookie valid for 1 year, httpOnly for security, sameSite=lax for OAuth redirect
  return `${AUTH_COOKIE_NAME}=${value}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure`;
}

export function clearAuthCookie(): string {
  return `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`;
}

export function setOAuthStateCookie(state: string): string {
  // Short-lived cookie (10 minutes) for CSRF protection during OAuth flow
  return `${OAUTH_STATE_COOKIE_NAME}=${state}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure`;
}

export function getOAuthStateCookie(request: Request): string | null {
  const cookies = request.headers.get('Cookie') || '';
  const match = cookies.match(new RegExp(`${OAUTH_STATE_COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

export function clearOAuthStateCookie(): string {
  return `${OAUTH_STATE_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`;
}

// Return URL cookie for preserving page during auth flow
export const RETURN_TO_COOKIE_NAME = 'mise_return_to';

export function setReturnToCookie(returnTo: string): string {
  // Short-lived cookie (10 minutes) to remember where to return after auth
  const encoded = encodeURIComponent(returnTo);
  return `${RETURN_TO_COOKIE_NAME}=${encoded}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax; Secure`;
}

export function getReturnToCookie(request: Request): string | null {
  const cookies = request.headers.get('Cookie') || '';
  const match = cookies.match(new RegExp(`${RETURN_TO_COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function clearReturnToCookie(): string {
  return `${RETURN_TO_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`;
}
