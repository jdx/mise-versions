import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";

export interface Migration {
  id: number;
  name: string;
  up: (db: ReturnType<typeof drizzle>) => Promise<void>;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "initial_schema",
    async up(db) {
      console.log("Running migration 1: initial_schema");

      // Create tokens table
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

      // Create token_usage table
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

      // Create indices
      await db.run(
        sql`CREATE INDEX IF NOT EXISTS idx_tokens_user_id ON tokens(user_id)`,
      );
      await db.run(
        sql`CREATE INDEX IF NOT EXISTS idx_tokens_active ON tokens(is_active)`,
      );
      await db.run(
        sql`CREATE INDEX IF NOT EXISTS idx_tokens_last_used ON tokens(last_used)`,
      );
      await db.run(
        sql`CREATE INDEX IF NOT EXISTS idx_token_usage_token_id ON token_usage(token_id)`,
      );
    },
  },

  {
    id: 2,
    name: "add_rate_limited_at_column",
    async up(db) {
      console.log("Running migration 2: add_rate_limited_at_column");

      // Add rate_limited_at column to tokens table
      await db.run(sql`
        ALTER TABLE tokens 
        ADD COLUMN rate_limited_at TEXT
      `);

      // Create index for the new column
      await db.run(
        sql`CREATE INDEX IF NOT EXISTS idx_tokens_rate_limited ON tokens(rate_limited_at)`,
      );
    },
  },
  {
    id: 3,
    name: "drop_token_usage_table",
    async up(db) {
      console.log("Running migration 3: drop_token_usage_table");
      await db.run(sql`DROP TABLE IF EXISTS token_usage`);
    },
  },
  {
    id: 4,
    name: "allow_null_expires_at",
    async up(db) {
      console.log("Running migration 4: allow_null_expires_at");

      // SQLite doesn't support ALTER COLUMN to change NOT NULL constraint
      // We need to recreate the table with the new schema
      await db.run(sql`
        CREATE TABLE tokens_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT,
          user_name TEXT,
          user_email TEXT,
          token TEXT NOT NULL,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          last_used TEXT,
          usage_count INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1,
          refresh_token TEXT,
          refresh_token_expires_at TEXT,
          scopes TEXT,
          last_validated TEXT,
          rate_limited_at TEXT
        )
      `);

      // Copy data from old table to new table
      await db.run(sql`
        INSERT INTO tokens_new 
        SELECT * FROM tokens
      `);

      // Drop old table
      await db.run(sql`DROP TABLE tokens`);

      // Rename new table to original name
      await db.run(sql`ALTER TABLE tokens_new RENAME TO tokens`);

      // Recreate indices
      await db.run(
        sql`CREATE INDEX IF NOT EXISTS idx_tokens_user_id ON tokens(user_id)`,
      );
      await db.run(
        sql`CREATE INDEX IF NOT EXISTS idx_tokens_active ON tokens(is_active)`,
      );
      await db.run(
        sql`CREATE INDEX IF NOT EXISTS idx_tokens_last_used ON tokens(last_used)`,
      );
      await db.run(
        sql`CREATE INDEX IF NOT EXISTS idx_tokens_rate_limited ON tokens(rate_limited_at)`,
      );
    },
  },
];

export async function runMigrations(db: ReturnType<typeof drizzle>) {
  console.log("Starting database migrations...");

  // Create migrations table if it doesn't exist
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  // Get list of applied migrations
  const appliedMigrations = await db.all(sql`
    SELECT id FROM migrations ORDER BY id
  `);

  const appliedIds = new Set(appliedMigrations.map((m: any) => m.id));

  // Run pending migrations
  for (const migration of migrations) {
    if (!appliedIds.has(migration.id)) {
      console.log(`Applying migration ${migration.id}: ${migration.name}`);

      try {
        await migration.up(db);

        // Record migration as applied
        await db.run(sql`
          INSERT INTO migrations (id, name, applied_at)
          VALUES (${migration.id}, ${migration.name}, ${new Date().toISOString()})
        `);

        console.log(`✅ Migration ${migration.id} applied successfully`);
      } catch (error) {
        console.error(`❌ Migration ${migration.id} failed:`, error);
        throw error;
      }
    } else {
      console.log(`⏭️  Migration ${migration.id} already applied`);
    }
  }

  console.log("✅ All migrations completed");
}

export async function getMigrationStatus(db: ReturnType<typeof drizzle>) {
  try {
    const appliedMigrations = await db.all(sql`
      SELECT id, name, applied_at FROM migrations ORDER BY id
    `);

    return {
      total: migrations.length,
      applied: appliedMigrations.length,
      pending: migrations.length - appliedMigrations.length,
      appliedMigrations: appliedMigrations as Array<{
        id: number;
        name: string;
        applied_at: string;
      }>,
    };
  } catch (error) {
    // Migrations table doesn't exist yet
    return {
      total: migrations.length,
      applied: 0,
      pending: migrations.length,
      appliedMigrations: [],
    };
  }
}
