import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  addFavorite,
  ensureFavoritesSchema,
  listFavorites,
  removeFavorite,
} from "../../../../src/favorites";
import { loadToolMeta, loadToolsByName } from "../../lib/data-loader";
import { isJsonRequest, privateJson, requireSession } from "../../lib/session";

async function readTool(request: Request): Promise<string | null> {
  if (!isJsonRequest(request)) return null;
  try {
    const body = await request.json<{ tool?: unknown }>();
    return typeof body.tool === "string" &&
      body.tool.length > 0 &&
      body.tool.length <= 200
      ? body.tool
      : null;
  } catch {
    return null;
  }
}

// GET /api/favorites - the signed-in user's favorite tools.
// With ?details=1, also returns tool summaries for the watchlist page.
export const GET: APIRoute = async ({ request, url }) => {
  const session = await requireSession(request, env.API_SECRET);
  if (session instanceof Response) return session;

  await ensureFavoritesSchema(env.DB);
  const favorites = await listFavorites(env.DB, session.username);
  if (url.searchParams.get("details") !== "1") {
    return privateJson({ favorites });
  }

  const { tools, downloads } = await loadToolsByName(
    env.ANALYTICS_DB,
    favorites,
  );
  return privateJson({
    favorites,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? null,
      backend: tool.backends?.[0] ?? null,
      latest_version: tool.latest_version,
      latest_stable_version: tool.latest_stable_version ?? null,
      last_updated: tool.last_updated,
      downloads_30d: downloads[tool.name] ?? 0,
    })),
  });
};

// PUT /api/favorites {"tool": "node"} - add a favorite (idempotent).
export const PUT: APIRoute = async ({ request }) => {
  const session = await requireSession(request, env.API_SECRET);
  if (session instanceof Response) return session;

  const tool = await readTool(request);
  if (!tool) return privateJson({ error: "Expected JSON body with tool" }, 400);
  if (!(await loadToolMeta(env.ANALYTICS_DB, tool))) {
    return privateJson({ error: "Unknown tool" }, 404);
  }

  await ensureFavoritesSchema(env.DB);
  const result = await addFavorite(env.DB, session.username, tool);
  if (result === "limit") {
    return privateJson({ error: "Favorites limit reached" }, 409);
  }
  return privateJson({ tool, favorited: true }, result === "added" ? 201 : 200);
};

// DELETE /api/favorites {"tool": "node"} - remove a favorite (idempotent).
export const DELETE: APIRoute = async ({ request }) => {
  const session = await requireSession(request, env.API_SECRET);
  if (session instanceof Response) return session;

  const tool = await readTool(request);
  if (!tool) return privateJson({ error: "Expected JSON body with tool" }, 400);

  await ensureFavoritesSchema(env.DB);
  await removeFavorite(env.DB, session.username, tool);
  return privateJson({ tool, favorited: false });
};
