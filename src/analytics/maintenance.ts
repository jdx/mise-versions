// Maintenance and data aggregation functions
import type { drizzle } from "drizzle-orm/d1";
import { sql, eq, and } from "drizzle-orm";
import { tools, backends, downloads, downloadsDaily } from "./schema.js";

export function createMaintenanceFunctions(db: ReturnType<typeof drizzle>) {
  return {
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
          sql`date(${downloads.created_at}, 'unixepoch')`,
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
                : sql`${downloadsDaily.platform_id} IS NULL`,
            ),
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

    // Backfill backend_id for existing records using default backends from registry
    async backfillBackends(
      registry: Array<{ short: string; backends: string[] }>,
      d1?: D1Database, // Optional D1 database for direct operations
    ): Promise<{
      updated: number;
      tools_mapped: number;
      backends_created: number;
    }> {
      // Build mapping of tool name -> default backend
      const toolToBackend = new Map<string, string>();
      for (const entry of registry) {
        if (entry.backends && entry.backends.length > 0) {
          toolToBackend.set(entry.short, entry.backends[0]);
        }
      }

      // First, insert all unique backends from registry using D1 batch API
      const uniqueBackends = [...new Set(toolToBackend.values())];
      let backendsCreated = 0;

      // Batch insert backends
      if (d1) {
        const BATCH_SIZE = 50;
        for (let i = 0; i < uniqueBackends.length; i += BATCH_SIZE) {
          const batch = uniqueBackends.slice(i, i + BATCH_SIZE);
          const statements = batch.map((full) =>
            d1
              .prepare("INSERT OR IGNORE INTO backends (full) VALUES (?)")
              .bind(full),
          );
          await d1.batch(statements);
          backendsCreated += batch.length;
        }
      } else {
        // Fallback to drizzle one-by-one
        for (const backendFull of uniqueBackends) {
          await db
            .insert(backends)
            .values({ full: backendFull })
            .onConflictDoNothing();
          backendsCreated++;
        }
      }

      // Now fetch all backends into memory for fast lookup
      const allBackends = await db
        .select({ id: backends.id, full: backends.full })
        .from(backends)
        .all();

      const backendIdMap = new Map<string, number>();
      for (const b of allBackends) {
        backendIdMap.set(b.full, b.id);
      }

      // Get all tools with NULL backend_id downloads
      const toolsWithNullBackend = (await db.all(sql`
        SELECT DISTINCT t.id, t.name
        FROM tools t
        JOIN downloads d ON d.tool_id = t.id
        WHERE d.backend_id IS NULL
      `)) as Array<{ id: number; name: string }>;

      let updated = 0;
      let toolsMapped = 0;

      // Build batch of updates
      const updates: Array<{
        toolId: number;
        backendId: number;
        toolName: string;
      }> = [];
      for (const tool of toolsWithNullBackend) {
        const backendFull = toolToBackend.get(tool.name);
        if (!backendFull) continue;

        const backendId = backendIdMap.get(backendFull);
        if (!backendId) continue;

        updates.push({ toolId: tool.id, backendId, toolName: tool.name });
        toolsMapped++;
      }

      // Process in batches using D1's batch API
      if (d1 && updates.length > 0) {
        const BATCH_SIZE = 50; // D1 allows up to ~100 statements per batch

        for (let i = 0; i < updates.length; i += BATCH_SIZE) {
          const batch = updates.slice(i, i + BATCH_SIZE);
          const statements: D1PreparedStatement[] = [];

          for (const { toolId, backendId } of batch) {
            statements.push(
              d1
                .prepare(
                  "UPDATE downloads SET backend_id = ? WHERE tool_id = ? AND backend_id IS NULL",
                )
                .bind(backendId, toolId),
            );
            statements.push(
              d1
                .prepare(
                  "UPDATE downloads_daily SET backend_id = ? WHERE tool_id = ? AND backend_id IS NULL",
                )
                .bind(backendId, toolId),
            );
          }

          try {
            await d1.batch(statements);
            updated += batch.length;
          } catch (e: any) {
            const batchTools = batch.map((b) => b.toolName).join(", ");
            throw new Error(
              `D1 batch update failed for tools [${batchTools}]: ${e?.message || e}`,
            );
          }
        }
      } else if (!d1) {
        // Fallback to drizzle one-by-one (slow but works for small datasets)
        for (const { toolId, backendId } of updates) {
          await db.run(
            sql.raw(
              `UPDATE downloads SET backend_id = ${backendId} WHERE tool_id = ${toolId} AND backend_id IS NULL`,
            ),
          );
          await db.run(
            sql.raw(
              `UPDATE downloads_daily SET backend_id = ${backendId} WHERE tool_id = ${toolId} AND backend_id IS NULL`,
            ),
          );
          updated++;
        }
      }

      return {
        updated,
        tools_mapped: toolsMapped,
        backends_created: backendsCreated,
      };
    },

    // Make backend_id NOT NULL (run after backfill)
    async makeBackendIdNotNull(): Promise<void> {
      // SQLite doesn't support ALTER COLUMN, so we need to recreate the tables
      // First, check if there are any NULL backend_ids remaining
      const nullCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(downloads)
        .where(sql`backend_id IS NULL`)
        .get();

      if (nullCount && nullCount.count > 0) {
        throw new Error(
          `Cannot make backend_id NOT NULL: ${nullCount.count} records still have NULL backend_id`,
        );
      }

      console.log(
        "All records have backend_id, proceeding with schema change...",
      );

      // Recreate downloads table with NOT NULL constraint
      await db.run(sql`
        CREATE TABLE downloads_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tool_id INTEGER NOT NULL,
          backend_id INTEGER NOT NULL,
          version TEXT NOT NULL,
          platform_id INTEGER,
          ip_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (tool_id) REFERENCES tools(id),
          FOREIGN KEY (backend_id) REFERENCES backends(id),
          FOREIGN KEY (platform_id) REFERENCES platforms(id)
        )
      `);

      await db.run(sql`
        INSERT INTO downloads_new (id, tool_id, backend_id, version, platform_id, ip_hash, created_at)
        SELECT id, tool_id, backend_id, version, platform_id, ip_hash, created_at
        FROM downloads
      `);

      await db.run(sql`DROP TABLE downloads`);
      await db.run(sql`ALTER TABLE downloads_new RENAME TO downloads`);

      // Recreate indices
      await db.run(
        sql`CREATE INDEX idx_downloads_tool_id ON downloads(tool_id)`,
      );
      await db.run(
        sql`CREATE INDEX idx_downloads_backend_id ON downloads(backend_id)`,
      );
      await db.run(
        sql`CREATE INDEX idx_downloads_created_at ON downloads(created_at)`,
      );
      await db.run(
        sql`CREATE INDEX idx_downloads_dedup ON downloads(tool_id, version, ip_hash, created_at)`,
      );

      // Recreate downloads_daily table with NOT NULL constraint
      await db.run(sql`
        CREATE TABLE downloads_daily_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tool_id INTEGER NOT NULL,
          backend_id INTEGER NOT NULL,
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

      await db.run(sql`
        INSERT INTO downloads_daily_new (id, tool_id, backend_id, version, platform_id, date, count, unique_ips)
        SELECT id, tool_id, backend_id, version, platform_id, date, count, unique_ips
        FROM downloads_daily
      `);

      await db.run(sql`DROP TABLE downloads_daily`);
      await db.run(
        sql`ALTER TABLE downloads_daily_new RENAME TO downloads_daily`,
      );

      // Recreate indices
      await db.run(
        sql`CREATE INDEX idx_downloads_daily_tool ON downloads_daily(tool_id)`,
      );
      await db.run(
        sql`CREATE INDEX idx_downloads_daily_backend ON downloads_daily(backend_id)`,
      );
      await db.run(
        sql`CREATE INDEX idx_downloads_daily_date ON downloads_daily(date)`,
      );

      console.log("Schema updated: backend_id is now NOT NULL");
    },
  };
}
