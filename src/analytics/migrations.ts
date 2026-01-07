// Analytics database migrations
import type { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";

export async function runAnalyticsMigrations(
  db: ReturnType<typeof drizzle>
): Promise<void> {
  console.log("Running analytics database migrations...");

  // Check if we need to migrate from old schema
  const tableInfo = await db.all(sql`PRAGMA table_info(downloads)`);
  const hasOldSchema = tableInfo.some(
    (col: any) => col.name === "tool" && col.type === "TEXT"
  );

  if (hasOldSchema) {
    console.log("Migrating from old schema to normalized schema...");

    // Create new lookup tables
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS tools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      )
    `);

    await db.run(sql`
      CREATE TABLE IF NOT EXISTS platforms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        os TEXT,
        arch TEXT,
        UNIQUE(os, arch)
      )
    `);

    // Populate tools from existing data
    await db.run(sql`
      INSERT OR IGNORE INTO tools (name)
      SELECT DISTINCT tool FROM downloads WHERE tool IS NOT NULL
    `);

    // Populate platforms from existing data
    await db.run(sql`
      INSERT OR IGNORE INTO platforms (os, arch)
      SELECT DISTINCT os, arch FROM downloads
    `);

    // Create new downloads table
    await db.run(sql`
      CREATE TABLE downloads_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_id INTEGER NOT NULL,
        version TEXT NOT NULL,
        platform_id INTEGER,
        ip_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (tool_id) REFERENCES tools(id),
        FOREIGN KEY (platform_id) REFERENCES platforms(id)
      )
    `);

    // Migrate data to new table
    await db.run(sql`
      INSERT INTO downloads_new (tool_id, version, platform_id, ip_hash, created_at)
      SELECT
        t.id,
        d.version,
        p.id,
        d.ip_hash,
        CAST(strftime('%s', d.created_at) AS INTEGER)
      FROM downloads d
      JOIN tools t ON t.name = d.tool
      LEFT JOIN platforms p ON (p.os = d.os OR (p.os IS NULL AND d.os IS NULL))
                            AND (p.arch = d.arch OR (p.arch IS NULL AND d.arch IS NULL))
    `);

    // Drop old table and rename new one
    await db.run(sql`DROP TABLE downloads`);
    await db.run(sql`ALTER TABLE downloads_new RENAME TO downloads`);

    console.log("Migration from old schema completed");
  } else {
    // Fresh install - create tables normally
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS tools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      )
    `);

    await db.run(sql`
      CREATE TABLE IF NOT EXISTS backends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full TEXT NOT NULL UNIQUE
      )
    `);

    await db.run(sql`
      CREATE TABLE IF NOT EXISTS platforms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        os TEXT,
        arch TEXT,
        UNIQUE(os, arch)
      )
    `);

    await db.run(sql`
      CREATE TABLE IF NOT EXISTS downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_id INTEGER NOT NULL,
        backend_id INTEGER,
        version TEXT NOT NULL,
        platform_id INTEGER,
        ip_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (tool_id) REFERENCES tools(id),
        FOREIGN KEY (backend_id) REFERENCES backends(id),
        FOREIGN KEY (platform_id) REFERENCES platforms(id)
      )
    `);
  }

  // Create backends table if it doesn't exist (for existing installations)
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS backends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full TEXT NOT NULL UNIQUE
    )
  `);

  // Add backend_id column to downloads if it doesn't exist
  const downloadsColumns = await db.all(sql`PRAGMA table_info(downloads)`);
  const hasBackendIdInDownloads = downloadsColumns.some(
    (col: any) => col.name === "backend_id"
  );
  if (!hasBackendIdInDownloads) {
    console.log("Adding backend_id column to downloads table...");
    await db.run(sql`ALTER TABLE downloads ADD COLUMN backend_id INTEGER`);
  }

  // Create daily aggregated table
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS downloads_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id INTEGER NOT NULL,
      backend_id INTEGER,
      version TEXT NOT NULL,
      platform_id INTEGER,
      date TEXT NOT NULL,
      count INTEGER NOT NULL,
      unique_ips INTEGER NOT NULL,
      FOREIGN KEY (tool_id) REFERENCES tools(id),
      FOREIGN KEY (backend_id) REFERENCES backends(id),
      FOREIGN KEY (platform_id) REFERENCES platforms(id)
    )
  `);

  // Add backend_id column to downloads_daily if it doesn't exist
  const dailyColumns = await db.all(sql`PRAGMA table_info(downloads_daily)`);
  const hasBackendIdInDaily = dailyColumns.some(
    (col: any) => col.name === "backend_id"
  );
  if (!hasBackendIdInDaily) {
    console.log("Adding backend_id column to downloads_daily table...");
    await db.run(sql`ALTER TABLE downloads_daily ADD COLUMN backend_id INTEGER`);
  }

  // Create indices for efficient queries
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_tool_id ON downloads(tool_id)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_backend_id ON downloads(backend_id)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_created_at ON downloads(created_at)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_dedup ON downloads(tool_id, version, ip_hash, created_at)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_ip_hash ON downloads(ip_hash)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_daily_tool ON downloads_daily(tool_id)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_daily_backend ON downloads_daily(backend_id)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_daily_date ON downloads_daily(date)`
  );

  // Create rollup tables for fast queries
  // Check if daily_tool_stats needs to be recreated (missing PRIMARY KEY)
  const toolStatsInfo = await db.all(sql`PRAGMA table_info(daily_tool_stats)`);
  const needsRecreate = toolStatsInfo.length === 0 || !toolStatsInfo.some((col: any) => col.pk > 0);

  if (needsRecreate) {
    console.log("Creating/recreating rollup tables with correct PRIMARY KEY constraints...");

    await db.run(sql`DROP TABLE IF EXISTS daily_stats`);
    await db.run(sql`
      CREATE TABLE daily_stats (
        date TEXT PRIMARY KEY,
        total_downloads INTEGER NOT NULL,
        unique_users INTEGER NOT NULL
      )
    `);

    await db.run(sql`DROP TABLE IF EXISTS daily_tool_stats`);
    await db.run(sql`
      CREATE TABLE daily_tool_stats (
        date TEXT NOT NULL,
        tool_id INTEGER NOT NULL,
        downloads INTEGER NOT NULL,
        unique_users INTEGER NOT NULL,
        PRIMARY KEY (date, tool_id)
      )
    `);

    await db.run(sql`DROP TABLE IF EXISTS daily_backend_stats`);
    await db.run(sql`
      CREATE TABLE daily_backend_stats (
        date TEXT NOT NULL,
        backend_type TEXT NOT NULL,
        downloads INTEGER NOT NULL,
        unique_users INTEGER NOT NULL,
        PRIMARY KEY (date, backend_type)
      )
    `);
  }

  // Create indices for rollup tables
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_daily_tool_stats_tool ON daily_tool_stats(tool_id)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_daily_tool_stats_date ON daily_tool_stats(date)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_daily_tool_stats_tool_date ON daily_tool_stats(tool_id, date)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_daily_backend_stats_type ON daily_backend_stats(backend_type)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_daily_backend_stats_date ON daily_backend_stats(date)`
  );

  // Create version_requests table for mise DAU/MAU tracking
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS version_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_version_requests_created_at ON version_requests(created_at)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_version_requests_ip_hash ON version_requests(ip_hash)`
  );

  // Create daily_version_stats rollup table
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS daily_version_stats (
      date TEXT PRIMARY KEY,
      total_requests INTEGER NOT NULL,
      unique_users INTEGER NOT NULL
    )
  `);

  // Add metadata columns to tools table if they don't exist
  const toolsColumns = await db.all(sql`PRAGMA table_info(tools)`);
  const existingToolsCols = new Set((toolsColumns as any[]).map((col: any) => col.name));

  const toolsMetadataCols = [
    { name: 'latest_version', type: 'TEXT' },
    { name: 'latest_stable_version', type: 'TEXT' },
    { name: 'version_count', type: 'INTEGER DEFAULT 0' },
    { name: 'last_updated', type: 'TEXT' },
    { name: 'description', type: 'TEXT' },
    { name: 'github', type: 'TEXT' },
    { name: 'homepage', type: 'TEXT' },
    { name: 'repo_url', type: 'TEXT' },
    { name: 'license', type: 'TEXT' },
    { name: 'backends', type: 'TEXT' },  // JSON array
    { name: 'authors', type: 'TEXT' },   // JSON array
    { name: 'security', type: 'TEXT' },  // JSON array
    { name: 'package_urls', type: 'TEXT' },  // JSON object
    { name: 'aqua_link', type: 'TEXT' },
    { name: 'metadata_updated_at', type: 'TEXT' },
  ];

  for (const col of toolsMetadataCols) {
    if (!existingToolsCols.has(col.name)) {
      console.log(`Adding ${col.name} column to tools table...`);
      await db.run(sql.raw(`ALTER TABLE tools ADD COLUMN ${col.name} ${col.type}`));
    }
  }

  // Ensure backends column has no NULLs (use empty JSON array as default)
  await db.run(sql`UPDATE tools SET backends = '[]' WHERE backends IS NULL`);

  // Create versions table for storing tool version data
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id INTEGER NOT NULL,
      version TEXT NOT NULL,
      created_at TEXT,
      release_url TEXT,
      FOREIGN KEY (tool_id) REFERENCES tools(id),
      UNIQUE(tool_id, version)
    )
  `);

  // Create indices for versions table
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_versions_tool_id ON versions(tool_id)`
  );

  // Create version_updates table for tracking when new versions are discovered
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS version_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      tool_id INTEGER NOT NULL,
      versions_added INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (tool_id) REFERENCES tools(id),
      UNIQUE(date, tool_id)
    )
  `);
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_version_updates_date ON version_updates(date)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_version_updates_tool_id ON version_updates(tool_id)`
  );

  // Create daily_combined_stats table for combined DAU (downloads + version_requests)
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS daily_combined_stats (
      date TEXT PRIMARY KEY,
      unique_users INTEGER NOT NULL
    )
  `);

  // Create daily_mau_stats table for trailing 30-day MAU per date
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS daily_mau_stats (
      date TEXT PRIMARY KEY,
      mau INTEGER NOT NULL
    )
  `);

  // Create daily_tool_backend_stats table for top tools by backend queries
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS daily_tool_backend_stats (
      date TEXT NOT NULL,
      tool_id INTEGER NOT NULL,
      backend_type TEXT NOT NULL,
      downloads INTEGER NOT NULL,
      PRIMARY KEY (date, tool_id, backend_type)
    )
  `);
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_daily_tool_backend_stats_date ON daily_tool_backend_stats(date)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_daily_tool_backend_stats_backend ON daily_tool_backend_stats(backend_type)`
  );

  console.log("Analytics migrations completed");
}
