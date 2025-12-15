// Analytics module for download tracking
// Uses a separate D1 database from token management
// Normalized schema for efficient storage at scale

import { drizzle } from "drizzle-orm/d1";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql, eq, and } from "drizzle-orm";

// Normalized schema

// Tools lookup table
export const tools = sqliteTable("tools", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
});

// Backends lookup table (full backend identifiers like "aqua:nektos/act")
export const backends = sqliteTable("backends", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  full: text("full").notNull().unique(), // e.g., "aqua:nektos/act", "core:node"
});

// Platforms lookup table (os + arch combinations)
export const platforms = sqliteTable("platforms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  os: text("os"),
  arch: text("arch"),
});

// Downloads table with foreign keys and integer timestamp
export const downloads = sqliteTable("downloads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tool_id: integer("tool_id").notNull(),
  backend_id: integer("backend_id"), // nullable for old records
  version: text("version").notNull(),
  platform_id: integer("platform_id"),
  ip_hash: text("ip_hash").notNull(),
  created_at: integer("created_at").notNull(), // Unix timestamp
});

// Daily aggregated data for historical stats (data older than 90 days)
export const downloadsDaily = sqliteTable("downloads_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tool_id: integer("tool_id").notNull(),
  backend_id: integer("backend_id"), // nullable for old records
  version: text("version").notNull(),
  platform_id: integer("platform_id"),
  date: text("date").notNull(), // YYYY-MM-DD
  count: integer("count").notNull(),
  unique_ips: integer("unique_ips").notNull(),
});

export function setupAnalytics(db: ReturnType<typeof drizzle>) {
  // Cache for tool, backend, and platform IDs to avoid repeated lookups
  const toolCache = new Map<string, number>();
  const backendCache = new Map<string, number>();
  const platformCache = new Map<string, number>();

  async function getOrCreateToolId(name: string): Promise<number> {
    // Check cache first
    if (toolCache.has(name)) {
      return toolCache.get(name)!;
    }

    // Try to find existing
    const existing = await db
      .select({ id: tools.id })
      .from(tools)
      .where(eq(tools.name, name))
      .get();

    if (existing) {
      toolCache.set(name, existing.id);
      return existing.id;
    }

    // Insert new
    await db.insert(tools).values({ name }).onConflictDoNothing();
    const inserted = await db
      .select({ id: tools.id })
      .from(tools)
      .where(eq(tools.name, name))
      .get();

    const id = inserted!.id;
    toolCache.set(name, id);
    return id;
  }

  async function getOrCreateBackendId(full: string | null): Promise<number | null> {
    if (!full) return null;

    // Check cache first
    if (backendCache.has(full)) {
      return backendCache.get(full)!;
    }

    // Try to find existing
    const existing = await db
      .select({ id: backends.id })
      .from(backends)
      .where(eq(backends.full, full))
      .get();

    if (existing) {
      backendCache.set(full, existing.id);
      return existing.id;
    }

    // Insert new
    await db.insert(backends).values({ full }).onConflictDoNothing();
    const inserted = await db
      .select({ id: backends.id })
      .from(backends)
      .where(eq(backends.full, full))
      .get();

    const id = inserted!.id;
    backendCache.set(full, id);
    return id;
  }

  async function getOrCreatePlatformId(
    os: string | null,
    arch: string | null
  ): Promise<number | null> {
    if (!os && !arch) return null;

    const key = `${os || ""}:${arch || ""}`;
    if (platformCache.has(key)) {
      return platformCache.get(key)!;
    }

    // Try to find existing
    const existing = await db
      .select({ id: platforms.id })
      .from(platforms)
      .where(
        and(
          os ? eq(platforms.os, os) : sql`${platforms.os} IS NULL`,
          arch ? eq(platforms.arch, arch) : sql`${platforms.arch} IS NULL`
        )
      )
      .get();

    if (existing) {
      platformCache.set(key, existing.id);
      return existing.id;
    }

    // Insert new
    await db.insert(platforms).values({ os, arch });
    const inserted = await db
      .select({ id: platforms.id })
      .from(platforms)
      .where(
        and(
          os ? eq(platforms.os, os) : sql`${platforms.os} IS NULL`,
          arch ? eq(platforms.arch, arch) : sql`${platforms.arch} IS NULL`
        )
      )
      .get();

    const id = inserted!.id;
    platformCache.set(key, id);
    return id;
  }

  return {
    // Track a download with daily deduplication per IP/tool/version
    async trackDownload(
      tool: string,
      version: string,
      ipHash: string,
      os: string | null,
      arch: string | null,
      full: string | null = null // Full backend identifier (e.g., "aqua:nektos/act")
    ): Promise<{ deduplicated: boolean }> {
      const toolId = await getOrCreateToolId(tool);
      const backendId = await getOrCreateBackendId(full);
      const platformId = await getOrCreatePlatformId(os, arch);
      const now = Math.floor(Date.now() / 1000);
      const todayStart = Math.floor(now / 86400) * 86400; // Start of today (UTC)

      // Check if already tracked today for this IP/tool/version
      const existing = await db
        .select()
        .from(downloads)
        .where(
          and(
            eq(downloads.tool_id, toolId),
            eq(downloads.version, version),
            eq(downloads.ip_hash, ipHash),
            sql`${downloads.created_at} >= ${todayStart}`
          )
        )
        .limit(1)
        .get();

      if (existing) {
        return { deduplicated: true };
      }

      // Insert new record
      await db.insert(downloads).values({
        tool_id: toolId,
        backend_id: backendId,
        version,
        platform_id: platformId,
        ip_hash: ipHash,
        created_at: now,
      });

      return { deduplicated: false };
    },

    // Get download stats for a specific tool
    async getDownloadStats(tool: string) {
      const toolRecord = await db
        .select({ id: tools.id })
        .from(tools)
        .where(eq(tools.name, tool))
        .get();

      if (!toolRecord) {
        return { total: 0, byVersion: [], byOs: [], daily: [] };
      }

      const toolId = toolRecord.id;

      // Total downloads (raw + aggregated)
      const rawTotal = await db
        .select({ count: sql<number>`count(*)` })
        .from(downloads)
        .where(eq(downloads.tool_id, toolId))
        .get();

      const aggTotal = await db
        .select({ count: sql<number>`coalesce(sum(count), 0)` })
        .from(downloadsDaily)
        .where(eq(downloadsDaily.tool_id, toolId))
        .get();

      const total = (rawTotal?.count ?? 0) + (aggTotal?.count ?? 0);

      // Downloads by version (top 10, from raw data only for simplicity)
      const byVersion = await db
        .select({
          version: downloads.version,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .where(eq(downloads.tool_id, toolId))
        .groupBy(downloads.version)
        .orderBy(sql`count(*) DESC`)
        .limit(10)
        .all();

      // Downloads by OS (join with platforms)
      const byOs = await db
        .select({
          os: platforms.os,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .leftJoin(platforms, eq(downloads.platform_id, platforms.id))
        .where(eq(downloads.tool_id, toolId))
        .groupBy(platforms.os)
        .all();

      // Daily downloads (last 30 days from raw data)
      const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
      const daily = await db
        .select({
          date: sql<string>`date(${downloads.created_at}, 'unixepoch')`,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .where(
          and(
            eq(downloads.tool_id, toolId),
            sql`${downloads.created_at} >= ${thirtyDaysAgo}`
          )
        )
        .groupBy(sql`date(${downloads.created_at}, 'unixepoch')`)
        .orderBy(sql`date(${downloads.created_at}, 'unixepoch')`)
        .all();

      // Monthly downloads (last 12 months from raw + aggregated data)
      const twelveMonthsAgo = Math.floor(Date.now() / 1000) - 365 * 86400;

      // Get from raw data
      const monthlyRaw = await db
        .select({
          month: sql<string>`strftime('%Y-%m', ${downloads.created_at}, 'unixepoch')`,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .where(
          and(
            eq(downloads.tool_id, toolId),
            sql`${downloads.created_at} >= ${twelveMonthsAgo}`
          )
        )
        .groupBy(sql`strftime('%Y-%m', ${downloads.created_at}, 'unixepoch')`)
        .all();

      // Get from aggregated data
      const monthlyAgg = await db
        .select({
          month: sql<string>`strftime('%Y-%m', ${downloadsDaily.date})`,
          count: sql<number>`sum(${downloadsDaily.count})`,
        })
        .from(downloadsDaily)
        .where(
          and(
            eq(downloadsDaily.tool_id, toolId),
            sql`${downloadsDaily.date} >= date(${twelveMonthsAgo}, 'unixepoch')`
          )
        )
        .groupBy(sql`strftime('%Y-%m', ${downloadsDaily.date})`)
        .all();

      // Merge monthly data
      const monthlyMap = new Map<string, number>();
      for (const r of monthlyRaw) {
        monthlyMap.set(r.month, (monthlyMap.get(r.month) || 0) + r.count);
      }
      for (const r of monthlyAgg) {
        monthlyMap.set(r.month, (monthlyMap.get(r.month) || 0) + r.count);
      }
      const monthly = Array.from(monthlyMap.entries())
        .map(([month, count]) => ({ month, count }))
        .sort((a, b) => a.month.localeCompare(b.month));

      return {
        total,
        byVersion,
        byOs,
        daily,
        monthly,
      };
    },

    // Get top downloaded tools (all time)
    async getTopTools(limit: number = 20) {
      const topTools = await db
        .select({
          name: tools.name,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .innerJoin(tools, eq(downloads.tool_id, tools.id))
        .groupBy(tools.name)
        .orderBy(sql`count(*) DESC`)
        .limit(limit)
        .all();

      const total = await db
        .select({ count: sql<number>`count(*)` })
        .from(downloads)
        .get();

      return {
        total: total?.count ?? 0,
        tools: topTools.map((t) => ({ tool: t.name, count: t.count })),
      };
    },

    // Get 30-day download counts for all tools
    async getAll30DayDownloads() {
      const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;

      const results = await db
        .select({
          name: tools.name,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .innerJoin(tools, eq(downloads.tool_id, tools.id))
        .where(sql`${downloads.created_at} >= ${thirtyDaysAgo}`)
        .groupBy(tools.name)
        .all();

      const counts: Record<string, number> = {};
      for (const r of results) {
        counts[r.name] = r.count;
      }
      return counts;
    },

    // Get monthly active users (unique IP hashes in last 30 days)
    async getMAU() {
      const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;

      const result = await db
        .select({
          count: sql<number>`count(distinct ip_hash)`,
        })
        .from(downloads)
        .where(sql`${downloads.created_at} >= ${thirtyDaysAgo}`)
        .get();

      return result?.count ?? 0;
    },

    // Aggregate old data (call this daily via cron)
    // Aggregates data older than 90 days into daily summaries
    async aggregateOldData(): Promise<{ aggregated: number; deleted: number }> {
      const ninetyDaysAgo = Math.floor(Date.now() / 1000) - 90 * 86400;

      // Get data to aggregate (grouped by tool, backend, version, platform, date)
      const toAggregate = await db
        .select({
          tool_id: downloads.tool_id,
          backend_id: downloads.backend_id,
          version: downloads.version,
          platform_id: downloads.platform_id,
          date: sql<string>`date(${downloads.created_at}, 'unixepoch')`,
          count: sql<number>`count(*)`,
          unique_ips: sql<number>`count(distinct ip_hash)`,
        })
        .from(downloads)
        .where(sql`${downloads.created_at} < ${ninetyDaysAgo}`)
        .groupBy(
          downloads.tool_id,
          downloads.backend_id,
          downloads.version,
          downloads.platform_id,
          sql`date(${downloads.created_at}, 'unixepoch')`
        )
        .all();

      if (toAggregate.length === 0) {
        return { aggregated: 0, deleted: 0 };
      }

      // Insert aggregated data
      for (const row of toAggregate) {
        // Check if aggregation already exists for this date
        const existing = await db
          .select()
          .from(downloadsDaily)
          .where(
            and(
              eq(downloadsDaily.tool_id, row.tool_id),
              eq(downloadsDaily.version, row.version),
              eq(downloadsDaily.date, row.date),
              row.backend_id
                ? eq(downloadsDaily.backend_id, row.backend_id)
                : sql`${downloadsDaily.backend_id} IS NULL`,
              row.platform_id
                ? eq(downloadsDaily.platform_id, row.platform_id)
                : sql`${downloadsDaily.platform_id} IS NULL`
            )
          )
          .get();

        if (existing) {
          // Update existing aggregation
          await db
            .update(downloadsDaily)
            .set({
              count: sql`${downloadsDaily.count} + ${row.count}`,
              unique_ips: sql`${downloadsDaily.unique_ips} + ${row.unique_ips}`,
            })
            .where(eq(downloadsDaily.id, existing.id));
        } else {
          // Insert new aggregation
          await db.insert(downloadsDaily).values({
            tool_id: row.tool_id,
            backend_id: row.backend_id,
            version: row.version,
            platform_id: row.platform_id,
            date: row.date,
            count: row.count,
            unique_ips: row.unique_ips,
          });
        }
      }

      // Count rows to delete
      const countToDelete = await db
        .select({ count: sql<number>`count(*)` })
        .from(downloads)
        .where(sql`${downloads.created_at} < ${ninetyDaysAgo}`)
        .get();

      // Delete old raw data
      await db
        .delete(downloads)
        .where(sql`${downloads.created_at} < ${ninetyDaysAgo}`);

      return {
        aggregated: toAggregate.length,
        deleted: countToDelete?.count ?? 0,
      };
    },

    // Get 30-day download stats grouped by backend type
    async getDownloadsByBackend() {
      const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;

      // Get downloads grouped by backend (extracts backend type from full identifier)
      const results = await db
        .select({
          backend: backends.full,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .leftJoin(backends, eq(downloads.backend_id, backends.id))
        .where(sql`${downloads.created_at} >= ${thirtyDaysAgo}`)
        .groupBy(backends.full)
        .all();

      // Group by backend type (e.g., "aqua:nektos/act" -> "aqua")
      const byType = new Map<string, number>();
      for (const r of results) {
        const backendType = r.backend
          ? r.backend.split(":")[0]
          : "unknown";
        byType.set(backendType, (byType.get(backendType) || 0) + r.count);
      }

      // Sort by count descending
      const sorted = [...byType.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([backend, count]) => ({ backend, count }));

      return sorted;
    },

    // Get top tools by backend type (30 days)
    async getTopToolsByBackend(limit: number = 5) {
      const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;

      // Get tool downloads with backend info
      const results = await db
        .select({
          tool: tools.name,
          backend: backends.full,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .innerJoin(tools, eq(downloads.tool_id, tools.id))
        .leftJoin(backends, eq(downloads.backend_id, backends.id))
        .where(sql`${downloads.created_at} >= ${thirtyDaysAgo}`)
        .groupBy(tools.name, backends.full)
        .all();

      // Group by backend type, then get top tools per type
      const byBackendType = new Map<string, Map<string, number>>();

      for (const r of results) {
        const backendType = r.backend
          ? r.backend.split(":")[0]
          : "unknown";

        if (!byBackendType.has(backendType)) {
          byBackendType.set(backendType, new Map());
        }
        const toolMap = byBackendType.get(backendType)!;
        toolMap.set(r.tool, (toolMap.get(r.tool) || 0) + r.count);
      }

      // Convert to result format with top tools per backend
      const result: Record<string, Array<{ tool: string; count: number }>> = {};

      for (const [backendType, toolMap] of byBackendType.entries()) {
        const topTools = [...toolMap.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([tool, count]) => ({ tool, count }));
        result[backendType] = topTools;
      }

      return result;
    },

    // Get all backend stats (combined endpoint for efficiency)
    async getBackendStats() {
      const [downloadsByBackend, topToolsByBackend] = await Promise.all([
        this.getDownloadsByBackend(),
        this.getTopToolsByBackend(),
      ]);

      return {
        downloads_by_backend: downloadsByBackend,
        top_tools_by_backend: topToolsByBackend,
      };
    },
  };
}

// Run migrations for analytics database
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
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_daily_tool ON downloads_daily(tool_id)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_daily_backend ON downloads_daily(backend_id)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_daily_date ON downloads_daily(date)`
  );

  console.log("Analytics migrations completed");
}
