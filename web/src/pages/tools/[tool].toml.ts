import type { APIRoute } from "astro";
import { legacyTomlResponse } from "../../lib/legacy-toml";

// Legacy endpoint: GET /tools/:tool.toml - serves the TOML version file
export const GET: APIRoute = ({ request, params, locals }) =>
  legacyTomlResponse({
    request,
    tool: params.tool,
    route: "tools/[tool].toml",
    waitUntil: (promise) => locals.cfContext.waitUntil(promise),
  });
