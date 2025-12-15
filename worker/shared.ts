// Shared types and utilities for Cloudflare Worker
import { drizzle } from "drizzle-orm/d1";

export interface Env {
  DB: D1Database;
  ANALYTICS_DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_CACHE: KVNamespace;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  API_SECRET: string;
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const AUTH_COOKIE_NAME = "mise_auth";
export const OAUTH_STATE_COOKIE_NAME = "mise_oauth_state";

export function getDb(env: Env) {
  return drizzle(env.DB);
}

export function jsonResponse(
  data: unknown,
  status = 200,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

// Cache control presets
export const CACHE_CONTROL = {
  // For static data that changes infrequently (tools.json, .toml files)
  STATIC: "public, max-age=600, stale-while-revalidate=86400", // 10 min + 1 day stale
  // For API responses (download stats, MAU, etc.)
  API: "public, max-age=600, stale-while-revalidate=86400", // 10 min + 1 day stale
} as const;

export function cachedJsonResponse(
  data: unknown,
  cacheControl: string,
  status = 200
) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": cacheControl,
    },
  });
}

export function errorResponse(message: string, status = 400) {
  return new Response(message, {
    status,
    headers: CORS_HEADERS,
  });
}

export function redirectResponse(
  url: string,
  headers: Record<string, string> | string[][] = {}
) {
  const responseHeaders = new Headers();
  responseHeaders.set("Location", url);

  if (Array.isArray(headers)) {
    // Support multiple headers with same name (e.g., multiple Set-Cookie)
    for (const [key, value] of headers) {
      responseHeaders.append(key, value);
    }
  } else {
    for (const [key, value] of Object.entries(headers)) {
      responseHeaders.set(key, value);
    }
  }

  return new Response(null, {
    status: 302,
    headers: responseHeaders,
  });
}

// HMAC signing for secure cookies
async function signData(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(data)
  );
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
  const cookies = request.headers.get("Cookie") || "";
  const match = cookies.match(new RegExp(`${AUTH_COOKIE_NAME}=([^;]+)`));
  if (!match) return null;

  try {
    const decoded = decodeURIComponent(match[1]);
    const [data, signature] = decoded.split(".");
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
  const cookies = request.headers.get("Cookie") || "";
  const match = cookies.match(new RegExp(`${OAUTH_STATE_COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

export function clearOAuthStateCookie(): string {
  return `${OAUTH_STATE_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`;
}

export function requireApiAuth(request: Request, env: Env): Response | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return errorResponse("Missing or invalid authorization header", 401);
  }

  const apiSecret = authHeader.slice(7);
  if (apiSecret !== env.API_SECRET) {
    return errorResponse("Invalid API secret", 401);
  }

  return null;
}
