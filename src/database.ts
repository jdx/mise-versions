import { drizzle } from "drizzle-orm/d1";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql, eq, gt, lte, isNull, isNotNull, and, or } from "drizzle-orm";

// GitHub tokens table for round-robin usage (user tokens only)
export const tokens = sqliteTable("tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  user_id: text("user_id"), // GitHub user ID or username
  user_name: text("user_name"), // GitHub display name
  user_email: text("user_email"), // GitHub email (if available)
  token: text("token").notNull(),
  expires_at: text("expires_at"),
  created_at: text("created_at").notNull(),
  last_used: text("last_used"),
  usage_count: integer("usage_count").notNull().default(0),
  is_active: integer("is_active").notNull().default(1), // 1 for active, 0 for inactive
  refresh_token: text("refresh_token"), // For GitHub apps with expiring tokens
  refresh_token_expires_at: text("refresh_token_expires_at"), // Refresh token expiration
  scopes: text("scopes"), // JSON array of token scopes
  last_validated: text("last_validated"), // Last time token was validated
  rate_limited_at: text("rate_limited_at"), // When token was rate limited (expires after 1 hour)
});

export function setupDatabase(db: ReturnType<typeof drizzle>) {
  return {
    // Create all tables (idempotent - safe to run multiple times)
    async setup() {
      console.log("Initializing database tables...");

      console.log("Database initialization complete");
    },

    // Get least recently used active token for round-robin
    // Excludes "jdx" tokens to preserve rate limits for manual use
    async getNextToken() {
      const result = await db
        .select()
        .from(tokens)
        .where(
          and(
            eq(tokens.is_active, 1),
            sql`${tokens.user_id} != 'jdx'`,
            or(
              isNull(tokens.expires_at),
              gt(tokens.expires_at, new Date().toISOString()),
            ),
            or(
              isNull(tokens.rate_limited_at),
              lte(tokens.rate_limited_at, new Date().toISOString()),
            ),
          ),
        )
        .orderBy(sql`COALESCE(last_used, '1970-01-01') ASC, usage_count ASC`)
        .limit(1)
        .get();

      if (result) {
        // Update last_used and increment usage_count
        await db
          .update(tokens)
          .set({
            last_used: new Date().toISOString(),
            usage_count: sql`usage_count + 1`,
          })
          .where(eq(tokens.id, result.id))
          .run();
      }

      return result;
    },

    // Mark a token as rate-limited for 1 hour
    async markTokenRateLimited(tokenId: number, resetAt?: string) {
      const rateLimitedUntil =
        resetAt || new Date(Date.now() + 60 * 60 * 1000).toISOString(); // Default to 60 minutes from now

      await db
        .update(tokens)
        .set({
          rate_limited_at: rateLimitedUntil,
        })
        .where(eq(tokens.id, tokenId))
        .run();

      console.log(
        `Token ${tokenId} marked as rate-limited until ${rateLimitedUntil}`,
      );
    },

    // Get all active tokens (all are user tokens now)
    async getAllTokens() {
      return await db
        .select()
        .from(tokens)
        .where(
          and(
            eq(tokens.is_active, 1),
            or(
              isNull(tokens.expires_at),
              gt(tokens.expires_at, new Date().toISOString()),
            ),
          ),
        )
        .orderBy(sql`COALESCE(last_used, '1970-01-01') ASC`)
        .all();
    },

    // Every usable pool token, ignoring the local rate-limited mark. Used by
    // the emergency path, which re-checks live quota itself.
    async getPoolTokens() {
      const now = new Date().toISOString();
      return await db
        .select()
        .from(tokens)
        .where(
          and(
            eq(tokens.is_active, 1),
            sql`${tokens.user_id} != 'jdx'`,
            or(isNull(tokens.expires_at), gt(tokens.expires_at, now)),
          ),
        )
        .all();
    },

    // getNextToken() counts a checkout when it picks a token. Take it back when
    // the token turns out not to be lent (skipped, invalid, or below the floor)
    // so usage_count only counts lookups the token actually helped with.
    async undoCheckout(tokenId: number) {
      await db
        .update(tokens)
        .set({ usage_count: sql`max(usage_count - 1, 0)` })
        .where(eq(tokens.id, tokenId))
        .run();
    },

    // Count a checkout that bypassed getNextToken() (the emergency path).
    async recordCheckout(tokenId: number) {
      await db
        .update(tokens)
        .set({
          last_used: new Date().toISOString(),
          usage_count: sql`usage_count + 1`,
        })
        .where(eq(tokens.id, tokenId))
        .run();
    },

    // Lookups a user's token(s) have helped with, and whether any of them is
    // still in the pool. A user can have several rows (one per sign-in), so
    // sum across all of them.
    async getUsageForUser(userId: string) {
      const now = new Date().toISOString();
      const row = await db
        .select({
          lookups: sql<number>`coalesce(sum(${tokens.usage_count}), 0)`,
          active: sql<number>`coalesce(sum(case when ${tokens.is_active} = 1 and (${tokens.expires_at} is null or ${tokens.expires_at} > ${now}) then 1 else 0 end), 0)`,
        })
        .from(tokens)
        .where(eq(tokens.user_id, userId))
        .get();
      return { lookups: row?.lookups ?? 0, sharing: (row?.active ?? 0) > 0 };
    },

    // Retire every token row for a user whose grant was revoked on GitHub.
    // Rows are kept (inactive, secrets cleared) so their lookup count survives.
    async retireUserTokens(userId: string) {
      await db
        .update(tokens)
        .set({ is_active: 0, token: "", refresh_token: null })
        .where(eq(tokens.user_id, userId))
        .run();
    },

    // Deactivate specific token rows and clear their secrets. `marker` goes in
    // the token column so different retirement reasons can be told apart.
    async retireTokens(tokenIds: number[], marker: string) {
      for (const id of tokenIds) {
        await db
          .update(tokens)
          .set({ is_active: 0, token: marker, refresh_token: null })
          .where(eq(tokens.id, id))
          .run();
      }
    },

    // Store new token
    async storeToken(
      userId: string | null,
      token: string,
      expiresAt: string | null,
      options?: {
        userName?: string;
        userEmail?: string;
        refreshToken?: string;
        refreshTokenExpiresAt?: string;
        scopes?: string[];
      },
    ) {
      const now = new Date().toISOString();

      return await db
        .insert(tokens)
        .values({
          user_id: userId,
          user_name: options?.userName,
          user_email: options?.userEmail,
          token,
          expires_at: expiresAt,
          created_at: now,
          last_validated: now,
          refresh_token: options?.refreshToken,
          refresh_token_expires_at: options?.refreshTokenExpiresAt,
          scopes: options?.scopes ? JSON.stringify(options.scopes) : null,
        })
        .returning()
        .get();
    },

    // Update token validation timestamp
    async updateTokenValidation(tokenId: number) {
      return await db
        .update(tokens)
        .set({
          last_validated: new Date().toISOString(),
        })
        .where(eq(tokens.id, tokenId))
        .run();
    },

    // Deactivate expired tokens
    async deactivateExpiredTokens() {
      const result = await db
        .update(tokens)
        .set({ is_active: 0 })
        .where(
          and(
            isNotNull(tokens.expires_at),
            lte(tokens.expires_at, new Date().toISOString()),
            eq(tokens.is_active, 1),
          ),
        )
        .run();

      console.log("Deactivated expired tokens");

      return result;
    },

    // Get tokens that will expire soon (within 24 hours) for proactive refresh
    async getExpiringTokens() {
      return await db
        .select()
        .from(tokens)
        .where(
          and(
            eq(tokens.is_active, 1),
            isNotNull(tokens.expires_at),
            lte(
              tokens.expires_at,
              new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            ),
            gt(tokens.expires_at, new Date().toISOString()),
          ),
        )
        .all();
    },

    // Get tokens with refresh tokens that can be refreshed
    async getRefreshableTokens() {
      return await db
        .select()
        .from(tokens)
        .where(
          and(
            eq(tokens.is_active, 1),
            isNotNull(tokens.refresh_token),
            or(
              isNull(tokens.refresh_token_expires_at),
              gt(tokens.refresh_token_expires_at, new Date().toISOString()),
            ),
            isNotNull(tokens.expires_at),
            lte(
              tokens.expires_at,
              new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            ),
          ),
        )
        .all();
    },

    // Get token by user ID
    async getTokenByUserId(userId: string) {
      return await db
        .select()
        .from(tokens)
        .where(
          and(
            eq(tokens.user_id, userId),
            eq(tokens.is_active, 1),
            or(
              isNull(tokens.expires_at),
              gt(tokens.expires_at, new Date().toISOString()),
            ),
          ),
        )
        .limit(1)
        .get();
    },

    // Get token statistics
    async getTokenStats() {
      const active = await db
        .select({ count: sql<number>`count(*)` })
        .from(tokens)
        .where(
          and(
            eq(tokens.is_active, 1),
            or(
              isNull(tokens.expires_at),
              gt(tokens.expires_at, new Date().toISOString()),
            ),
            or(
              isNull(tokens.rate_limited_at),
              lte(tokens.rate_limited_at, new Date().toISOString()),
            ),
          ),
        )
        .get();

      const total = await db
        .select({ count: sql<number>`count(*)` })
        .from(tokens)
        .get();

      return {
        active: active?.count ?? 0,
        total: total?.count ?? 0,
      };
    },

    // Aggregate, non-identifying pool numbers for the public explainer page.
    // Mirrors getNextToken(): the maintainer's own token is not in the pool.
    async getPublicPoolStats() {
      const now = new Date().toISOString();
      const row = await db
        .select({
          contributors: sql<number>`count(distinct ${tokens.user_id})`,
          available: sql<number>`coalesce(sum(case when ${tokens.rate_limited_at} is null or ${tokens.rate_limited_at} <= ${now} then 1 else 0 end), 0)`,
          checkouts: sql<number>`coalesce(sum(${tokens.usage_count}), 0)`,
        })
        .from(tokens)
        .where(
          and(
            eq(tokens.is_active, 1),
            sql`${tokens.user_id} != 'jdx'`,
            or(isNull(tokens.expires_at), gt(tokens.expires_at, now)),
          ),
        )
        .get();

      return {
        contributors: row?.contributors ?? 0,
        available: row?.available ?? 0,
        checkouts: row?.checkouts ?? 0,
      };
    },

    // Delete a token by ID
    async deleteToken(tokenId: number) {
      return await db.delete(tokens).where(eq(tokens.id, tokenId)).run();
    },

    // Delete multiple tokens by IDs
    async deleteTokens(tokenIds: number[]) {
      if (tokenIds.length === 0) return { rowsAffected: 0 };

      let deleted = 0;
      for (const id of tokenIds) {
        await db.delete(tokens).where(eq(tokens.id, id)).run();
        deleted++;
      }
      return { rowsAffected: deleted };
    },
  };
}
