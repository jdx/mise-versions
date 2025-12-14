// Shared types and utilities for Cloudflare Pages Functions
import { drizzle } from "drizzle-orm/d1";

export interface Env {
  DB: D1Database;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  API_SECRET: string;
}

export type PagesContext = EventContext<Env, string, unknown>;

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const AUTH_COOKIE_NAME = "mise_auth";

export function getDb(env: Env) {
  return drizzle(env.DB);
}

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

export function errorResponse(message: string, status = 400) {
  return new Response(message, {
    status,
    headers: CORS_HEADERS,
  });
}

export function redirectResponse(url: string, headers: Record<string, string> = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      ...headers,
    },
  });
}

export function getAuthCookie(request: Request): { username: string } | null {
  const cookies = request.headers.get("Cookie") || "";
  const match = cookies.match(new RegExp(`${AUTH_COOKIE_NAME}=([^;]+)`));
  if (!match) return null;

  try {
    return JSON.parse(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

export function setAuthCookie(username: string): string {
  const value = encodeURIComponent(JSON.stringify({ username }));
  // Cookie valid for 1 year, httpOnly for security, sameSite=lax for OAuth redirect
  return `${AUTH_COOKIE_NAME}=${value}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure`;
}

export function clearAuthCookie(): string {
  return `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`;
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
