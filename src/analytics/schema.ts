// Analytics schema - normalized tables for download tracking
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

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

// Rollup tables for fast queries

// Global daily stats (for MAU/DAU)
export const dailyStats = sqliteTable("daily_stats", {
  date: text("date").primaryKey(), // YYYY-MM-DD
  total_downloads: integer("total_downloads").notNull(),
  unique_users: integer("unique_users").notNull(), // DAU
});

// Per-tool daily stats (for 30-day download counts)
export const dailyToolStats = sqliteTable("daily_tool_stats", {
  date: text("date").notNull(),
  tool_id: integer("tool_id").notNull(),
  downloads: integer("downloads").notNull(),
  unique_users: integer("unique_users").notNull(),
});

// Per-backend daily stats (for backend charts)
export const dailyBackendStats = sqliteTable("daily_backend_stats", {
  date: text("date").notNull(),
  backend_type: text("backend_type").notNull(), // "aqua", "core", etc.
  downloads: integer("downloads").notNull(),
  unique_users: integer("unique_users").notNull(),
});

// Version requests table - tracks mise CLI requests for DAU/MAU
export const versionRequests = sqliteTable("version_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ip_hash: text("ip_hash").notNull(),
  created_at: integer("created_at").notNull(), // Unix timestamp
});

// Daily stats for version requests (for mise DAU/MAU)
export const dailyVersionStats = sqliteTable("daily_version_stats", {
  date: text("date").primaryKey(), // YYYY-MM-DD
  total_requests: integer("total_requests").notNull(),
  unique_users: integer("unique_users").notNull(), // DAU
});

// Version updates tracking (when new tool versions are discovered)
export const versionUpdates = sqliteTable("version_updates", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(), // YYYY-MM-DD
  tool_id: integer("tool_id").notNull(),
  versions_added: integer("versions_added").notNull().default(1),
});

// Daily combined stats - unique users across downloads + version_requests (deduplicated)
export const dailyCombinedStats = sqliteTable("daily_combined_stats", {
  date: text("date").primaryKey(), // YYYY-MM-DD
  unique_users: integer("unique_users").notNull(), // Combined DAU
});

// Daily MAU stats - stores trailing 30-day MAU for each date
// This allows showing historical MAU trends on charts
export const dailyMauStats = sqliteTable("daily_mau_stats", {
  date: text("date").primaryKey(), // YYYY-MM-DD
  mau: integer("mau").notNull(), // 30-day trailing unique users as of this date
});

// Per-tool per-backend daily stats (for top tools by backend queries)
export const dailyToolBackendStats = sqliteTable("daily_tool_backend_stats", {
  date: text("date").notNull(),
  tool_id: integer("tool_id").notNull(),
  backend_type: text("backend_type").notNull(), // "aqua", "core", etc.
  downloads: integer("downloads").notNull(),
});
