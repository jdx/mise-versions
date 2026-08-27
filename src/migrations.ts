import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";

export interface Migration {
  id: number;
  name: string;
  up: (db: ReturnType<typeof drizzle>) => Promise<void>;
}

async function addTokenObservabilitySchema(
  db: ReturnType<typeof drizzle>,
  log = true,
): Promise<void> {
  if (log) console.log("Running migration 5: add_token_observability");

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS token_observation_runs (
      observed_at TEXT PRIMARY KEY,
      token_count INTEGER NOT NULL
    )
  `);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS token_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id INTEGER NOT NULL,
      user_id TEXT,
      user_name TEXT,
      observed_at TEXT NOT NULL,
      remaining INTEGER,
      limit_count INTEGER,
      reset_at TEXT,
      usage_count INTEGER NOT NULL,
      is_available INTEGER NOT NULL,
      error TEXT
    )
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_token_observations_time
    ON token_observations(observed_at)
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_token_observations_token_time
    ON token_observations(token_id, observed_at)
  `);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS token_alert_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      level TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      last_sent_at TEXT,
      updated_at TEXT NOT NULL
    )
  `);
}

export async function ensureTokenObservabilitySchema(
  db: ReturnType<typeof drizzle>,
): Promise<void> {
  await addTokenObservabilitySchema(db, false);
}

async function ensureTokenObservationIndexes(
  db: ReturnType<typeof drizzle>,
): Promise<void> {
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_token_observations_time
    ON token_observations(observed_at)
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_token_observations_token_time
    ON token_observations(token_id, observed_at)
  `);
}

async function preserveTokenObservationSnapshots(
  db: ReturnType<typeof drizzle>,
): Promise<void> {
  console.log("Running migration 6: preserve_token_observation_snapshots");

  const columns = (await db.all(
    sql`PRAGMA table_info(token_observations)`,
  )) as Array<{ name: string }>;
  const foreignKeys = (await db.all(
    sql`PRAGMA foreign_key_list(token_observations)`,
  )) as Array<{ table: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  const hasIdentityColumns =
    columnNames.has("user_id") && columnNames.has("user_name");
  const referencesTokens = foreignKeys.some(
    (foreignKey) => foreignKey.table === "tokens",
  );

  if (hasIdentityColumns && !referencesTokens) {
    await ensureTokenObservationIndexes(db);
    return;
  }

  await db.run(sql`DROP TABLE IF EXISTS token_observations_new`);
  await db.run(sql`
    CREATE TABLE token_observations_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id INTEGER NOT NULL,
      user_id TEXT,
      user_name TEXT,
      observed_at TEXT NOT NULL,
      remaining INTEGER,
      limit_count INTEGER,
      reset_at TEXT,
      usage_count INTEGER NOT NULL,
      is_available INTEGER NOT NULL,
      error TEXT
    )
  `);

  if (hasIdentityColumns) {
    await db.run(sql`
      INSERT INTO token_observations_new
        (id, token_id, user_id, user_name, observed_at, remaining, limit_count,
         reset_at, usage_count, is_available, error)
      SELECT id, token_id, user_id, user_name, observed_at, remaining,
             limit_count, reset_at, usage_count, is_available, error
      FROM token_observations
    `);
  } else {
    await db.run(sql`
      INSERT INTO token_observations_new
        (id, token_id, user_id, user_name, observed_at, remaining, limit_count,
         reset_at, usage_count, is_available, error)
      SELECT o.id, o.token_id, t.user_id, t.user_name, o.observed_at,
             o.remaining, o.limit_count, o.reset_at, o.usage_count,
             o.is_available, o.error
      FROM token_observations o
      LEFT JOIN tokens t ON t.id = o.token_id
    `);
  }

  await db.run(sql`DROP TABLE token_observations`);
  await db.run(
    sql`ALTER TABLE token_observations_new RENAME TO token_observations`,
  );
  await ensureTokenObservationIndexes(db);
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
  {
    id: 5,
    name: "add_token_observability",
    async up(db) {
      await addTokenObservabilitySchema(db);
    },
  },
  {
    id: 6,
    name: "preserve_token_observation_snapshots",
    async up(db) {
      await preserveTokenObservationSnapshots(db);
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
