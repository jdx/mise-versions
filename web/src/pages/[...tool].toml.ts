import type { APIRoute } from "astro";
import { legacyTomlResponse } from "../lib/legacy-toml";

// Legacy endpoint: GET /:tool.toml - serves the TOML version file
// e.g., /node.toml returns TOML with version metadata
export const GET: APIRoute = ({ request, params, locals }) =>
  legacyTomlResponse({
    request,
    tool: params.tool,
    route: "[...tool].toml",
    waitUntil: (promise) => locals.cfContext.waitUntil(promise),
  });
