import { drizzle } from 'drizzle-orm/d1';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// GitHub tokens table for round-robin usage (user tokens only)
export const tokens = sqliteTable('tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  user_id: text('user_id'), // GitHub user ID or username
  user_name: text('user_name'), // GitHub display name
  user_email: text('user_email'), // GitHub email (if available)
  token: text('token').notNull(),
  expires_at: text('expires_at').notNull(),
  created_at: text('created_at').notNull(),
  last_used: text('last_used'),
  usage_count: integer('usage_count').notNull().default(0),
  is_active: integer('is_active').notNull().default(1), // 1 for active, 0 for inactive
  refresh_token: text('refresh_token'), // For GitHub apps with expiring tokens
  refresh_token_expires_at: text('refresh_token_expires_at'), // Refresh token expiration
  scopes: text('scopes'), // JSON array of token scopes
  last_validated: text('last_validated'), // Last time token was validated
});

// Token usage tracking for rate limiting
export const token_usage = sqliteTable('token_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  token_id: integer('token_id').notNull().references(() => tokens.id),
  endpoint: text('endpoint').notNull(),
  used_at: text('used_at').notNull(),
  remaining_requests: integer('remaining_requests'),
  reset_at: text('reset_at'),
});

export function setupDatabase(db: ReturnType<typeof drizzle>) {
  return {
    // Create all tables (idempotent - safe to run multiple times)
    async setup() {
      console.log('Initializing database tables...');
      
      await db.run(sql`
        CREATE TABLE IF NOT EXISTS tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT,
          user_name TEXT,
          user_email TEXT,
          token TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_used TEXT,
          usage_count INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1,
          refresh_token TEXT,
          refresh_token_expires_at TEXT,
          scopes TEXT,
          last_validated TEXT
        )
      `);

      await db.run(sql`
        CREATE TABLE IF NOT EXISTS token_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_id INTEGER NOT NULL,
          endpoint TEXT NOT NULL,
          used_at TEXT NOT NULL,
          remaining_requests INTEGER,
          reset_at TEXT,
          FOREIGN KEY (token_id) REFERENCES tokens (id)
        )
      `);

      // Create indices for better performance (IF NOT EXISTS is implicit for indices)
      try {
        await db.run(sql`CREATE INDEX IF NOT EXISTS idx_tokens_user_id ON tokens(user_id)`);
        await db.run(sql`CREATE INDEX IF NOT EXISTS idx_tokens_active ON tokens(is_active)`);
        await db.run(sql`CREATE INDEX IF NOT EXISTS idx_tokens_last_used ON tokens(last_used)`);
        await db.run(sql`CREATE INDEX IF NOT EXISTS idx_token_usage_token_id ON token_usage(token_id)`);
      } catch (error) {
        // Indices might already exist, that's fine
        console.log('Some indices already exist, continuing...');
      }
      
      console.log('Database initialization complete');
    },

    // Get least recently used active token for round-robin
    async getNextToken() {
      const result = await db.select()
        .from(tokens)
        .where(sql`is_active = 1 AND expires_at > datetime('now')`)
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
          .where(sql`id = ${result.id}`)
          .run();
      }
      
      return result;
    },

    // Get all active tokens (all are user tokens now)
    async getAllTokens() {
      return await db.select()
        .from(tokens)
        .where(sql`is_active = 1 AND expires_at > datetime('now')`)
        .orderBy(sql`COALESCE(last_used, '1970-01-01') ASC`)
        .all();
    },

    // Store new token
    async storeToken(
      userId: string | null, 
      token: string, 
      expiresAt: string,
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
        .where(sql`id = ${tokenId}`)
        .run();
    },

    // Record token usage for rate limit tracking
    async recordTokenUsage(tokenId: number, endpoint: string, remainingRequests?: number, resetAt?: string) {
      return await db.insert(token_usage)
        .values({
          token_id: tokenId,
          endpoint,
          used_at: new Date().toISOString(),
          remaining_requests: remainingRequests,
          reset_at: resetAt,
        })
        .run();
    },

    // Deactivate expired tokens
    async deactivateExpiredTokens() {
      const result = await db.update(tokens)
        .set({ is_active: 0 })
        .where(sql`expires_at <= datetime('now') AND is_active = 1`)
        .run();
      
      console.log('Deactivated expired tokens');
      
      return result;
    },

    // Get tokens that will expire soon (within 24 hours) for proactive refresh
    async getExpiringTokens() {
      return await db.select()
        .from(tokens)
        .where(sql`is_active = 1 AND expires_at <= datetime('now', '+24 hours') AND expires_at > datetime('now')`)
        .all();
    },

    // Get tokens with refresh tokens that can be refreshed
    async getRefreshableTokens() {
      return await db.select()
        .from(tokens)
        .where(sql`
          is_active = 1 
          AND refresh_token IS NOT NULL 
          AND (refresh_token_expires_at IS NULL OR refresh_token_expires_at > datetime('now'))
          AND expires_at <= datetime('now', '+1 hour')
        `)
        .all();
    },

    // Get token statistics
    async getTokenStats() {
      const active = await db.select({ count: sql<number>`count(*)` })
        .from(tokens)
        .where(sql`is_active = 1 AND expires_at > datetime('now')`)
        .get();
      
      const total = await db.select({ count: sql<number>`count(*)` })
        .from(tokens)
        .get();

      return {
        active: active?.count || 0,
        total: total?.count || 0,
      };
    }
  };
} 
