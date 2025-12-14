// Analytics module for download tracking
// Uses a separate D1 database from token management

import { drizzle } from "drizzle-orm/d1";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql, eq, and } from "drizzle-orm";

// Downloads table schema
export const downloads = sqliteTable("downloads", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tool: text("tool").notNull(),
  version: text("version").notNull(),
  ip_hash: text("ip_hash").notNull(), // SHA256 hash of IP for privacy
  os: text("os"),
  arch: text("arch"),
  created_at: text("created_at").notNull(),
});

export function setupAnalytics(db: ReturnType<typeof drizzle>) {
  return {
    // Track a download with daily deduplication per IP/tool/version
    async trackDownload(
      tool: string,
      version: string,
      ipHash: string,
      os: string | null,
      arch: string | null
    ): Promise<{ deduplicated: boolean }> {
      const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

      // Check if already tracked today for this IP/tool/version
      const existing = await db
        .select()
        .from(downloads)
        .where(
          and(
            eq(downloads.tool, tool),
            eq(downloads.version, version),
            eq(downloads.ip_hash, ipHash),
            sql`date(created_at) = ${today}`
          )
        )
        .limit(1)
        .get();

      if (existing) {
        return { deduplicated: true };
      }

      // Insert new record
      await db.insert(downloads).values({
        tool,
        version,
        ip_hash: ipHash,
        os,
        arch,
        created_at: new Date().toISOString(),
      });

      return { deduplicated: false };
    },

    // Get download stats for a specific tool
    async getDownloadStats(tool: string) {
      // Total downloads
      const total = await db
        .select({ count: sql<number>`count(*)` })
        .from(downloads)
        .where(eq(downloads.tool, tool))
        .get();

      // Downloads by version (top 10)
      const byVersion = await db
        .select({
          version: downloads.version,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .where(eq(downloads.tool, tool))
        .groupBy(downloads.version)
        .orderBy(sql`count(*) DESC`)
        .limit(10)
        .all();

      // Downloads by OS
      const byOs = await db
        .select({
          os: downloads.os,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .where(eq(downloads.tool, tool))
        .groupBy(downloads.os)
        .all();

      return {
        total: total?.count ?? 0,
        byVersion,
        byOs,
      };
    },

    // Get top downloaded tools
    async getTopTools(limit: number = 20) {
      const topTools = await db
        .select({
          tool: downloads.tool,
          count: sql<number>`count(*)`,
        })
        .from(downloads)
        .groupBy(downloads.tool)
        .orderBy(sql`count(*) DESC`)
        .limit(limit)
        .all();

      const total = await db
        .select({ count: sql<number>`count(*)` })
        .from(downloads)
        .get();

      return {
        total: total?.count ?? 0,
        tools: topTools,
      };
    },
  };
}

// Run migrations for analytics database
export async function runAnalyticsMigrations(
  db: ReturnType<typeof drizzle>
): Promise<void> {
  console.log("Running analytics database migrations...");

  // Create downloads table if it doesn't exist
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool TEXT NOT NULL,
      version TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      os TEXT,
      arch TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // Create indices for efficient queries
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_tool ON downloads(tool)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_tool_version ON downloads(tool, version)`
  );
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_created_at ON downloads(created_at)`
  );
  // Compound index for deduplication check
  await db.run(
    sql`CREATE INDEX IF NOT EXISTS idx_downloads_dedup ON downloads(ip_hash, tool, version, created_at)`
  );

  console.log("Analytics migrations completed");
}
