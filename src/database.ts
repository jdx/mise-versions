import { drizzle } from 'drizzle-orm/d1';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql, eq, gt, lte, isNull, isNotNull, and, or } from 'drizzle-orm';

// GitHub tokens table for round-robin usage (user tokens only)
export const tokens = sqliteTable('tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  user_id: text('user_id'), // GitHub user ID or username
  user_name: text('user_name'), // GitHub display name
  user_email: text('user_email'), // GitHub email (if available)
  token: text('token').notNull(),
  expires_at: text('expires_at'),
  created_at: text('created_at').notNull(),
  last_used: text('last_used'),
  usage_count: integer('usage_count').notNull().default(0),
  is_active: integer('is_active').notNull().default(1), // 1 for active, 0 for inactive
  refresh_token: text('refresh_token'), // For GitHub apps with expiring tokens
  refresh_token_expires_at: text('refresh_token_expires_at'), // Refresh token expiration
  scopes: text('scopes'), // JSON array of token scopes
  last_validated: text('last_validated'), // Last time token was validated
  rate_limited_at: text('rate_limited_at'), // When token was rate limited (expires after 1 hour)
});

export function setupDatabase(db: ReturnType<typeof drizzle>) {
  return {
    // Create all tables (idempotent - safe to run multiple times)
    async setup() {
      console.log('Initializing database tables...');
      
      console.log('Database initialization complete');
    },

    // Get least recently used active token for round-robin
    async getNextToken() {
      const result = await db.select()
        .from(tokens)
        .where(and(
          eq(tokens.is_active, 1),
          or(isNull(tokens.expires_at), gt(tokens.expires_at, new Date().toISOString())),
          or(isNull(tokens.rate_limited_at), lte(tokens.rate_limited_at, new Date().toISOString()))
        ))
        .orderBy(sql`COALESCE(last_used, '1970-01-01') ASC, usage_count ASC`)
        .limit(1)
        .get();
      
      if (result) {
        // Update last_used and increment usage_count
        await db.update(tokens)
          .set({
            last_used: new Date().toISOString(),
            usage_count: sql`usage_count + 1`
          })
          .where(eq(tokens.id, result.id))
          .run();
      }
      
      return result;
    },

    // Mark a token as rate-limited for 1 hour
    async markTokenRateLimited(tokenId: number, resetAt?: string) {
      const rateLimitedUntil = resetAt || new Date(Date.now() + 60 * 60 * 1000).toISOString(); // Default to 60 minutes from now
      
      await db.update(tokens)
        .set({
          rate_limited_at: rateLimitedUntil
        })
        .where(eq(tokens.id, tokenId))
        .run();
      
      console.log(`Token ${tokenId} marked as rate-limited until ${rateLimitedUntil}`);
    },

    // Get all active tokens (all are user tokens now)
    async getAllTokens() {
      return await db.select()
        .from(tokens)
        .where(and(
          eq(tokens.is_active, 1),
          or(isNull(tokens.expires_at), gt(tokens.expires_at, new Date().toISOString()))
        ))
        .orderBy(sql`COALESCE(last_used, '1970-01-01') ASC`)
        .all();
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
      }
    ) {
      const now = new Date().toISOString();
      
      return await db.insert(tokens)
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
      return await db.update(tokens)
        .set({ 
          last_validated: new Date().toISOString() 
        })
        .where(eq(tokens.id, tokenId))
        .run();
    },

    // Deactivate expired tokens
    async deactivateExpiredTokens() {
      const result = await db.update(tokens)
        .set({ is_active: 0 })
        .where(and(
          isNotNull(tokens.expires_at),
          lte(tokens.expires_at, new Date().toISOString()), 
          eq(tokens.is_active, 1)
        ))
        .run();
      
      console.log('Deactivated expired tokens');
      
      return result;
    },

    // Get tokens that will expire soon (within 24 hours) for proactive refresh
    async getExpiringTokens() {
      return await db.select()
        .from(tokens)
        .where(and(
          eq(tokens.is_active, 1),
          isNotNull(tokens.expires_at),
          lte(tokens.expires_at, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()),
          gt(tokens.expires_at, new Date().toISOString())
        ))
        .all();
    },

    // Get tokens with refresh tokens that can be refreshed
    async getRefreshableTokens() {
      return await db.select()
        .from(tokens)
        .where(and(
          eq(tokens.is_active, 1),
          isNotNull(tokens.refresh_token),
          or(isNull(tokens.refresh_token_expires_at), gt(tokens.refresh_token_expires_at, new Date().toISOString())),
          isNotNull(tokens.expires_at),
          lte(tokens.expires_at, new Date(Date.now() + 60 * 60 * 1000).toISOString())
        ))
        .all();
    },

    // Get token by user ID
    async getTokenByUserId(userId: string) {
      return await db.select()
        .from(tokens)
        .where(and(
          eq(tokens.user_id, userId),
          eq(tokens.is_active, 1),
          or(isNull(tokens.expires_at), gt(tokens.expires_at, new Date().toISOString()))
        ))
        .limit(1)
        .get();
    },

    // Get token statistics
    async getTokenStats() {
      const active = await db.select({ count: sql<number>`count(*)` })
        .from(tokens)
        .where(and(
          eq(tokens.is_active, 1),
          or(isNull(tokens.expires_at), gt(tokens.expires_at, new Date().toISOString())),
          or(isNull(tokens.rate_limited_at), lte(tokens.rate_limited_at, new Date().toISOString()))
        ))
        .get();
      
      const total = await db.select({ count: sql<number>`count(*)` })
        .from(tokens)
        .get();

      return {
        active: active?.count ?? 0,
        total: total?.count ?? 0,
      };
    }
  };
} 
