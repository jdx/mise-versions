// Simple router utility for Cloudflare Workers
import { Env, CORS_HEADERS } from "./shared";

type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS";

type RouteHandler = (
  request: Request,
  env: Env,
  params: Record<string, string>
) => Promise<Response> | Response;

interface Route {
  method: Method | Method[];
  pattern: string;
  handler: RouteHandler;
}

interface RouterOptions {
  onNotFound?: (request: Request, env: Env) => Promise<Response> | Response;
}

export class Router {
  private routes: Route[] = [];
  private options: RouterOptions;

  constructor(options: RouterOptions = {}) {
    this.options = options;
  }

  private addRoute(method: Method | Method[], pattern: string, handler: RouteHandler) {
    this.routes.push({ method, pattern, handler });
    return this;
  }

  get(pattern: string, handler: RouteHandler) {
    return this.addRoute("GET", pattern, handler);
  }

  post(pattern: string, handler: RouteHandler) {
    return this.addRoute("POST", pattern, handler);
  }

  all(pattern: string, handler: RouteHandler) {
    return this.addRoute(["GET", "POST", "PUT", "DELETE", "PATCH"], pattern, handler);
  }

  on(method: Method | Method[], pattern: string, handler: RouteHandler) {
    return this.addRoute(method, pattern, handler);
  }

  async handle(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method as Method;

    // Handle OPTIONS preflight
    if (method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    for (const route of this.routes) {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      if (!methods.includes(method)) continue;

      const params = matchPattern(route.pattern, path);
      if (params !== null) {
        return route.handler(request, env, params);
      }
    }

    // No route matched
    if (this.options.onNotFound) {
      return this.options.onNotFound(request, env);
    }
    return null;
  }
}

// Match a route pattern against a path
// Supports :param for named parameters
// Returns params object if matched, null otherwise
function matchPattern(pattern: string, path: string): Record<string, string> | null {
  // Handle wildcard patterns like "/data/*"
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1); // Remove "*" but keep "/"
    if (path.startsWith(prefix) || path === prefix.slice(0, -1)) {
      return { "*": path.slice(prefix.length) };
    }
    return null;
  }

  const patternParts = pattern.split("/");
  const pathParts = path.split("/");

  if (patternParts.length !== pathParts.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    const pathPart = pathParts[i];

    if (patternPart.startsWith(":")) {
      // Named parameter - must have at least one character
      if (!pathPart) {
        return null;
      }
      params[patternPart.slice(1)] = pathPart;
    } else if (patternPart !== pathPart) {
      return null;
    }
  }

  return params;
}
