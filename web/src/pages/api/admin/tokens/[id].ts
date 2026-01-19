import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupDatabase } from "../../../../../../src/database";
import { jsonResponse, errorResponse } from "../../../../lib/api";
import { requireAdminAuth } from "../../../../lib/admin";

// DELETE /api/admin/tokens/[id] - Delete a specific token (admin only)
export const DELETE: APIRoute = async ({ request, params, locals }) => {
  const runtime = locals.runtime;

  // Check admin auth (cookie-based)
  const authResult = await requireAdminAuth(request, runtime.env.API_SECRET);
  if (authResult instanceof Response) {
    return authResult;
  }

  const tokenId = parseInt(params.id || "", 10);
  if (isNaN(tokenId)) {
    return errorResponse("Invalid token ID", 400);
  }

  const db = drizzle(runtime.env.DB);
  const database = setupDatabase(db);

  await database.deleteToken(tokenId);

  return jsonResponse({ success: true, deleted: tokenId });
};
