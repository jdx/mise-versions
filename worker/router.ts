// Simple declarative router for Cloudflare Workers
import { Env } from "./shared";

type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
type Handler = (request: Request, env: Env, params?: Record<string, string>) => Promise<Response>;

interface Route {
  method: Method | Method[];
  path: string | RegExp;
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: Method | Method[], path: string | RegExp, handler: Handler): this {
    this.routes.push({ method, path, handler });
    return this;
  }

  get(path: string | RegExp, handler: Handler): this {
    return this.add("GET", path, handler);
  }

  post(path: string | RegExp, handler: Handler): this {
    return this.add("POST", path, handler);
  }

  async handle(request: Request, env: Env): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method as Method;

    for (const route of this.routes) {
      // Check method
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      if (!methods.includes(method)) continue;

      // Check path
      if (typeof route.path === "string") {
        if (route.path !== path) continue;
        return route.handler(request, env);
      } else {
        // RegExp path with capture groups
        const match = path.match(route.path);
        if (!match) continue;

        // Extract named groups or positional params
        const params: Record<string, string> = {};
        if (match.groups) {
          Object.assign(params, match.groups);
        } else if (match.length > 1) {
          // Positional params as $1, $2, etc.
          for (let i = 1; i < match.length; i++) {
            params[`$${i}`] = match[i];
          }
        }
        return route.handler(request, env, params);
      }
    }

    return null; // No route matched
  }
}
