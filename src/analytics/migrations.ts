// Analytics database migrations
import type { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";

type AnalyticsDb = ReturnType<typeof drizzle>;

interface AnalyticsMigration {
  id: number;
  name: string;
  up: (db: AnalyticsDb) => Promise<void>;
}

const analyticsMigrations: AnalyticsMigration[] = [
  {
    id: 1,
    name: "backfill_prerelease_flags",
    async up(db) {
      await db.run(sql`
        UPDATE versions
        SET prerelease = 1
        WHERE prerelease = 0
          AND (
            version GLOB '*-M[0-9]*'
            OR version GLOB '*-RC[0-9]*'
            OR lower(version) GLOB '*-m[0-9]*'
            OR lower(version) GLOB '*-rc[0-9]*'
            OR lower(version) LIKE '%-alpha%'
            OR lower(version) LIKE '%-beta%'
            OR lower(version) LIKE '%-dev%'
            OR lower(version) LIKE '%-milestone%'
            OR lower(version) LIKE '%-nightly%'
            OR lower(version) LIKE '%-pre%'
            OR lower(version) LIKE '%-preview%'
            OR lower(version) LIKE '%-snapshot%'
            OR lower(version) LIKE '%-canary%'
          )
      `);
    },
  },
  {
    id: 2,
    name: "populate_download_summaries",
    async up(db) {
      const now = Math.floor(Date.now() / 1000);
      const thirtyDaysAgo = new Date((now - 30 * 86400) * 1000)
        .toISOString()
        .split("T")[0];
      const updatedAt = new Date().toISOString();

      await db.run(sql`
        INSERT OR REPLACE INTO tool_download_summaries (
          tool_id,
          downloads_30d,
          downloads_all_time,
          updated_at
        )
        WITH all_time AS (
          SELECT tool_id, SUM(downloads) AS downloads_all_time
          FROM (
            SELECT tool_id, COUNT(*) AS downloads
            FROM downloads
            GROUP BY tool_id
            UNION ALL
            SELECT tool_id, SUM(count) AS downloads
            FROM downloads_daily
            GROUP BY tool_id
          )
          GROUP BY tool_id
        ),
        recent AS (
          SELECT tool_id, SUM(downloads) AS downloads_30d
          FROM daily_tool_stats
          WHERE date >= ${thirtyDaysAgo}
          GROUP BY tool_id
        )
        SELECT
          t.id,
          COALESCE(r.downloads_30d, 0),
          COALESCE(a.downloads_all_time, 0),
          ${updatedAt}
        FROM tools t
        LEFT JOIN all_time a ON a.tool_id = t.id
        LEFT JOIN recent r ON r.tool_id = t.id
      `);

      await db.run(sql`
        INSERT OR REPLACE INTO tool_platform_download_summaries (
          tool_id,
          platform_id,
          downloads_all_time
        )
        SELECT
          tool_id,
          COALESCE(platform_id, 0) AS platform_id,
          SUM(downloads) AS downloads_all_time
        FROM (
          SELECT tool_id, platform_id, COUNT(*) AS downloads
          FROM downloads
          GROUP BY tool_id, platform_id
          UNION ALL
          SELECT tool_id, platform_id, SUM(count) AS downloads
          FROM downloads_daily
          GROUP BY tool_id, platform_id
        )
        GROUP BY tool_id, COALESCE(platform_id, 0)
      `);

      await db.run(sql`
        INSERT OR REPLACE INTO tool_version_download_summaries (
          tool_id,
          version,
          downloads_all_time
        )
        SELECT
          tool_id,
          version,
          SUM(downloads) AS downloads_all_time
        FROM (
          SELECT tool_id, version, COUNT(*) AS downloads
          FROM downloads
          GROUP BY tool_id, version
          UNION ALL
          SELECT tool_id, version, SUM(count) AS downloads
          FROM downloads_daily
          GROUP BY tool_id, version
        )
        GROUP BY tool_id, version
      `);
    },
  },
  {
    id: 3,
    name: "populate_hot_ui_summaries",
    async up(db) {
      const LOOKBACK_DAYS = 30;
      const SPARKLINE_DAYS = 13;
      const MIN_DOWNLOADS = 500;
      const now = Math.floor(Date.now() / 1000);
      const thirtyDaysAgo = new Date((now - LOOKBACK_DAYS * 86400) * 1000)
        .toISOString()
        .split("T")[0];
      const today = new Date(now * 1000).toISOString().split("T")[0];
      const updatedAt = new Date().toISOString();
      const lookupDates = Array.from(
        { length: LOOKBACK_DAYS },
        (_, index) =>
          new Date((now - (index + 1) * 86400) * 1000)
            .toISOString()
            .split("T")[0],
      );
      const sparklineDates = lookupDates.slice(0, SPARKLINE_DAYS).reverse();

      await db.run(sql`
        INSERT OR REPLACE INTO backend_tool_summaries (
          backend_type,
          tool_count,
          updated_at
        )
        SELECT
          SUBSTR(value, 1, INSTR(value || ':', ':') - 1) AS backend_type,
          COUNT(DISTINCT tools.id) AS tool_count,
          ${updatedAt}
        FROM tools, json_each(backends)
        WHERE latest_version IS NOT NULL
          AND backends IS NOT NULL
        GROUP BY backend_type
      `);

      const backendRows = await db.get<{ count: number }>(sql`
        SELECT COUNT(*) AS count
        FROM backend_tool_summaries
        WHERE updated_at = ${updatedAt}
      `);
      if ((backendRows?.count ?? 0) > 0) {
        await db.run(sql`
          DELETE FROM backend_tool_summaries
          WHERE updated_at != ${updatedAt}
        `);
      }

      const dailyData = await db.all<{
        tool_id: number;
        downloads_30d: number;
        date: string;
        downloads: number;
      }>(sql`
        WITH candidates AS (
          SELECT
            daily_tool_stats.tool_id,
            SUM(daily_tool_stats.downloads) AS downloads_30d
          FROM daily_tool_stats
            INNER JOIN tools ON daily_tool_stats.tool_id = tools.id
          WHERE
            daily_tool_stats.date >= ${thirtyDaysAgo}
            AND daily_tool_stats.date < ${today}
            AND tools.latest_version IS NOT NULL
          GROUP BY daily_tool_stats.tool_id
          HAVING SUM(daily_tool_stats.downloads) >= ${MIN_DOWNLOADS}
        )
        SELECT
          daily_tool_stats.tool_id,
          candidates.downloads_30d,
          daily_tool_stats.date,
          daily_tool_stats.downloads
        FROM daily_tool_stats
          INNER JOIN candidates ON daily_tool_stats.tool_id = candidates.tool_id
        WHERE
          daily_tool_stats.date >= ${thirtyDaysAgo}
          AND daily_tool_stats.date < ${today}
        ORDER BY daily_tool_stats.date
      `);

      const toolData = new Map<
        number,
        { total: number; daily: Map<string, number> }
      >();
      for (const row of dailyData) {
        if (!toolData.has(row.tool_id)) {
          toolData.set(row.tool_id, {
            total: row.downloads_30d,
            daily: new Map(),
          });
        }
        toolData.get(row.tool_id)!.daily.set(row.date, row.downloads);
      }

      let trendingRows = 0;
      for (const [toolId, data] of toolData) {
        const dailyValues = lookupDates.map(
          (date) => data.daily.get(date) ?? 0,
        );
        const mean =
          dailyValues.reduce((sum, value) => sum + value, 0) /
          dailyValues.length;
        const variance =
          dailyValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
          dailyValues.length;
        const stddev = Math.sqrt(variance);
        if (stddev === 0) continue;

        const recentAvg =
          (dailyValues[0] + dailyValues[1] + dailyValues[2]) / 3;
        const dailyBoost = (recentAvg - mean) / stddev;
        const sparkline = sparklineDates.map(
          (date) => data.daily.get(date) ?? 0,
        );

        await db.run(sql`
          INSERT OR REPLACE INTO trending_tool_summaries (
            tool_id,
            downloads_30d,
            daily_boost,
            trending_score,
            sparkline,
            updated_at
          )
          VALUES (
            ${toolId},
            ${data.total},
            ${dailyBoost},
            ${dailyBoost},
            ${JSON.stringify(sparkline)},
            ${updatedAt}
          )
        `);
        trendingRows++;
      }

      if (trendingRows > 0) {
        await db.run(sql`
          DELETE FROM trending_tool_summaries
          WHERE updated_at != ${updatedAt}
        `);
      }
    },
  },
];

async function runAnalyticsDataMigrations(db: AnalyticsDb): Promise<void> {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS analytics_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const appliedMigrations = await db.all(sql`
    SELECT id FROM analytics_migrations ORDER BY id
  `);
  const appliedIds = new Set(appliedMigrations.map((m: any) => m.id));

  for (const migration of analyticsMigrations) {
    if (appliedIds.has(migration.id)) {
      continue;
    }

    console.log(
      `Applying analytics migration ${migration.id}: ${migration.name}`,
    );
    await migration.up(db);
    await db.run(sql`
      INSERT INTO analytics_migrations (id, name, applied_at)
      VALUES (${migration.id}, ${migration.name}, ${new Date().toISOString()})
    `);
  }
}

export async function runAnalyticsMigrations(db: AnalyticsDb): Promise<void> {
  console.log("Running analytics database migrations...");

  // Check if we need to migrate from old schema
  const tableInfo = await db.all(sql`PRAGMA table_info(downloads)`);
  const hasOldSchema = tableInfo.some(
    (col: any) => col.name === "tool" && col.type === "TEXT",
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
    (col: any) => col.name === "backend_id",
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
    (col: any) => col.name === "backend_id",
  );
  if (!hasBackendIdInDaily) {
    console.log("Adding backend_id column to downloads_daily table...");
    await db.run(
      sql`ALTER TABLE downloads_daily ADD COLUMN backend_id INTEGER`,
    );
  }

  // Create indices for efficient queries
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_tool_id ON downloads(tool_id)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_backend_id ON downloads(backend_id)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_created_at ON downloads(created_at)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_dedup ON downloads(tool_id, version, ip_hash, created_at)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_tool_platform ON downloads(tool_id, platform_id)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_tool_created ON downloads(tool_id, created_at)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_ip_hash ON downloads(ip_hash)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_daily_tool ON downloads_daily(tool_id)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_daily_backend ON downloads_daily(backend_id)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_daily_date ON downloads_daily(date)`,
  );

  // Create rollup tables for fast queries
  // Check if daily_tool_stats needs to be recreated (missing PRIMARY KEY)
  const toolStatsInfo = await db.all(sql`PRAGMA table_info(daily_tool_stats)`);
  const needsRecreate =
    toolStatsInfo.length === 0 || !toolStatsInfo.some((col: any) => col.pk > 0);

  if (needsRecreate) {
    console.log(
      "Creating/recreating rollup tables with correct PRIMARY KEY constraints...",
    );

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
    sql`CREATE INDEX IF NOT EXISTS idx_daily_tool_stats_tool ON daily_tool_stats(tool_id)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_daily_tool_stats_date ON daily_tool_stats(date)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_daily_tool_stats_date_tool_downloads ON daily_tool_stats(date, tool_id, downloads)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_daily_tool_stats_tool_date ON daily_tool_stats(tool_id, date)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_daily_backend_stats_type ON daily_backend_stats(backend_type)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_daily_backend_stats_date ON daily_backend_stats(date)`,
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
    sql`CREATE INDEX IF NOT EXISTS idx_version_requests_created_at ON version_requests(created_at)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_version_requests_ip_hash ON version_requests(ip_hash)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_version_requests_ip_created ON version_requests(ip_hash, created_at)`,
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
  const existingToolsCols = new Set(
    (toolsColumns as any[]).map((col: any) => col.name),
  );

  const toolsMetadataCols = [
    { name: "latest_version", type: "TEXT" },
    { name: "latest_stable_version", type: "TEXT" },
    { name: "version_count", type: "INTEGER DEFAULT 0" },
    { name: "last_updated", type: "TEXT" },
    { name: "description", type: "TEXT" },
    { name: "github", type: "TEXT" },
    { name: "homepage", type: "TEXT" },
    { name: "repo_url", type: "TEXT" },
    { name: "license", type: "TEXT" },
    { name: "backends", type: "TEXT" }, // JSON array
    { name: "authors", type: "TEXT" }, // JSON array
    { name: "security", type: "TEXT" }, // JSON array
    { name: "package_urls", type: "TEXT" }, // JSON object
    { name: "aqua_link", type: "TEXT" },
    { name: "metadata_updated_at", type: "TEXT" },
  ];

  for (const col of toolsMetadataCols) {
    if (!existingToolsCols.has(col.name)) {
      console.log(`Adding ${col.name} column to tools table...`);
      await db.run(
        sql.raw(`ALTER TABLE tools ADD COLUMN ${col.name} ${col.type}`),
      );
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
    sql`CREATE INDEX IF NOT EXISTS idx_versions_tool_id ON versions(tool_id)`,
  );

  // Add from_mise column to versions table (1 = from mise ls-remote, 0 = from user tracking)
  const versionsColumns = await db.all(sql`PRAGMA table_info(versions)`);
  const hasFromMise = versionsColumns.some(
    (col: any) => col.name === "from_mise",
  );
  if (!hasFromMise) {
    console.log("Adding from_mise column to versions table...");
    await db.run(
      sql`ALTER TABLE versions ADD COLUMN from_mise INTEGER DEFAULT 1`,
    );
    // Set existing versions as from_mise since they came from the sync script
    await db.run(
      sql`UPDATE versions SET from_mise = 1 WHERE from_mise IS NULL`,
    );
  }

  // Add sort_order column to versions table for preserving TOML file order
  const hasSortOrder = versionsColumns.some(
    (col: any) => col.name === "sort_order",
  );
  if (!hasSortOrder) {
    console.log("Adding sort_order column to versions table...");
    await db.run(sql`ALTER TABLE versions ADD COLUMN sort_order INTEGER`);
    // Initialize sort_order based on existing id order
    await db.run(sql`
      UPDATE versions SET sort_order = (
        SELECT COUNT(*) FROM versions v2
        WHERE v2.tool_id = versions.tool_id AND v2.id <= versions.id
      ) - 1
    `);
  }
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_versions_tool_mise_order ON versions(tool_id, from_mise, sort_order, id)`,
  );

  // Add prerelease column to versions table (1 = upstream marked prerelease,
  // 0 = stable / unknown). Stored as INTEGER to match the rest of the schema's
  // boolean-as-int convention. Defaults to 0 for existing rows; the sync
  // script will refresh values on the next run for tools that emit the flag.
  const hasPrerelease = versionsColumns.some(
    (col: any) => col.name === "prerelease",
  );
  if (!hasPrerelease) {
    console.log("Adding prerelease column to versions table...");
    await db.run(
      sql`ALTER TABLE versions ADD COLUMN prerelease INTEGER NOT NULL DEFAULT 0`,
    );
  }
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_versions_tool_mise_prerelease_order ON versions(tool_id, from_mise, prerelease, sort_order, id)`,
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
    sql`CREATE INDEX IF NOT EXISTS idx_version_updates_date ON version_updates(date)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_version_updates_tool_id ON version_updates(tool_id)`,
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
    sql`CREATE INDEX IF NOT EXISTS idx_daily_tool_backend_stats_date ON daily_tool_backend_stats(date)`,
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_daily_tool_backend_stats_backend ON daily_tool_backend_stats(backend_type)`,
  );

  // Summary tables for hot read paths. These are maintained by scheduled
  // rollups and let UI requests avoid scanning downloads/downloads_daily.
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS tool_download_summaries (
      tool_id INTEGER PRIMARY KEY,
      downloads_30d INTEGER NOT NULL DEFAULT 0,
      downloads_all_time INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (tool_id) REFERENCES tools(id)
    )
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_tool_download_summaries_30d
    ON tool_download_summaries(downloads_30d DESC, tool_id)
  `);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS tool_platform_download_summaries (
      tool_id INTEGER NOT NULL,
      platform_id INTEGER NOT NULL,
      downloads_all_time INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tool_id, platform_id),
      FOREIGN KEY (tool_id) REFERENCES tools(id)
    )
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_tool_platform_download_summaries_platform
    ON tool_platform_download_summaries(platform_id)
  `);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS tool_version_download_summaries (
      tool_id INTEGER NOT NULL,
      version TEXT NOT NULL,
      downloads_all_time INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tool_id, version),
      FOREIGN KEY (tool_id) REFERENCES tools(id)
    )
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_tool_version_download_summaries_tool_downloads
    ON tool_version_download_summaries(tool_id, downloads_all_time DESC)
  `);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS backend_tool_summaries (
      backend_type TEXT PRIMARY KEY,
      tool_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_backend_tool_summaries_count
    ON backend_tool_summaries(tool_count DESC, backend_type)
  `);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS trending_tool_summaries (
      tool_id INTEGER PRIMARY KEY,
      downloads_30d INTEGER NOT NULL DEFAULT 0,
      daily_boost REAL NOT NULL DEFAULT 0,
      trending_score REAL NOT NULL DEFAULT 0,
      sparkline TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (tool_id) REFERENCES tools(id)
    )
  `);
  await db.run(sql`
    CREATE INDEX IF NOT EXISTS idx_trending_tool_summaries_score
    ON trending_tool_summaries(trending_score DESC, tool_id)
  `);

  await runAnalyticsDataMigrations(db);

  console.log("Analytics migrations completed");
}
