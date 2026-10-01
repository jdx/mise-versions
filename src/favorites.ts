// Per-user favorite tools, stored in the main D1 database next to the tokens
// table. `user_id` is the GitHub login from the signed auth cookie.

export const MAX_FAVORITES = 200;

export type AddFavoriteResult = "added" | "exists" | "limit";

export async function listFavorites(
  db: D1Database,
  userId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT tool FROM favorites WHERE user_id = ? ORDER BY created_at DESC, tool ASC",
    )
    .bind(userId)
    .all<{ tool: string }>();
  return results.map((row) => row.tool);
}

export async function addFavorite(
  db: D1Database,
  userId: string,
  tool: string,
): Promise<AddFavoriteResult> {
  // Single statement so concurrent requests cannot push a user past the cap.
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO favorites (user_id, tool, created_at)
       SELECT ?1, ?2, ?3
       WHERE (SELECT COUNT(*) FROM favorites WHERE user_id = ?1) < ?4`,
    )
    .bind(userId, tool, new Date().toISOString(), MAX_FAVORITES)
    .run();
  if (result.meta.changes > 0) return "added";

  const existing = await db
    .prepare("SELECT 1 AS found FROM favorites WHERE user_id = ? AND tool = ?")
    .bind(userId, tool)
    .first();
  return existing ? "exists" : "limit";
}

export async function removeFavorite(
  db: D1Database,
  userId: string,
  tool: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM favorites WHERE user_id = ? AND tool = ?")
    .bind(userId, tool)
    .run();
}
