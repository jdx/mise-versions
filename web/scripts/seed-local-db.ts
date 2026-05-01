/**
 * Seed script for local D1 database
 * Run with: npx wrangler d1 execute ANALYTICS_DB --local --file=scripts/seed.sql
 */

// This script generates SQL to seed the local database
// Run it to generate the SQL, then execute with wrangler

const tools = [
  "node",
  "python",
  "ruby",
  "go",
  "rust",
  "java",
  "deno",
  "bun",
  "terraform",
  "kubectl",
  "helm",
  "docker",
  "git",
  "ripgrep",
  "fd",
  "jq",
  "yq",
  "fzf",
  "bat",
  "exa",
];

const backends = [
  "core",
  "aqua",
  "ubi",
  "asdf",
  "vfox",
  "cargo",
  "npm",
  "go",
  "pipx",
];

// Generate SQL
console.log(`-- Seed data for local development
-- Run: npx wrangler d1 execute ANALYTICS_DB --local --file=web/scripts/seed.sql

-- Create tables
CREATE TABLE IF NOT EXISTS tools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS backends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS platforms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  os TEXT,
  arch TEXT,
  UNIQUE(os, arch)
);

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
);

CREATE TABLE IF NOT EXISTS downloads_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id INTEGER NOT NULL,
  backend_id INTEGER,
  version TEXT NOT NULL,
  platform_id INTEGER,
  date TEXT NOT NULL,
  count INTEGER NOT NULL,
  unique_ips INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY,
  total_downloads INTEGER NOT NULL,
  unique_users INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_tool_stats (
  date TEXT NOT NULL,
  tool_id INTEGER NOT NULL,
  downloads INTEGER NOT NULL,
  unique_users INTEGER NOT NULL,
  PRIMARY KEY (date, tool_id)
);

CREATE TABLE IF NOT EXISTS daily_backend_stats (
  date TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  downloads INTEGER NOT NULL,
  unique_users INTEGER NOT NULL,
  PRIMARY KEY (date, backend_type)
);

CREATE TABLE IF NOT EXISTS tool_download_summaries (
  tool_id INTEGER PRIMARY KEY,
  downloads_30d INTEGER NOT NULL DEFAULT 0,
  downloads_all_time INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_platform_download_summaries (
  tool_id INTEGER NOT NULL,
  platform_id INTEGER NOT NULL,
  downloads_all_time INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool_id, platform_id)
);

CREATE TABLE IF NOT EXISTS tool_version_download_summaries (
  tool_id INTEGER NOT NULL,
  version TEXT NOT NULL,
  downloads_all_time INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool_id, version)
);

CREATE TABLE IF NOT EXISTS backend_tool_summaries (
  backend_type TEXT PRIMARY KEY,
  tool_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trending_tool_summaries (
  tool_id INTEGER PRIMARY KEY,
  downloads_30d INTEGER NOT NULL DEFAULT 0,
  daily_boost REAL NOT NULL DEFAULT 0,
  trending_score REAL NOT NULL DEFAULT 0,
  sparkline TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Create indices
CREATE INDEX IF NOT EXISTS idx_downloads_tool_id ON downloads(tool_id);
CREATE INDEX IF NOT EXISTS idx_downloads_backend_id ON downloads(backend_id);
CREATE INDEX IF NOT EXISTS idx_downloads_created_at ON downloads(created_at);
CREATE INDEX IF NOT EXISTS idx_downloads_dedup ON downloads(tool_id, version, ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_daily_tool_stats_tool ON daily_tool_stats(tool_id);
CREATE INDEX IF NOT EXISTS idx_daily_tool_stats_date_tool_downloads ON daily_tool_stats(date, tool_id, downloads);
CREATE INDEX IF NOT EXISTS idx_daily_backend_stats_type ON daily_backend_stats(backend_type);
CREATE INDEX IF NOT EXISTS idx_tool_download_summaries_30d ON tool_download_summaries(downloads_30d DESC, tool_id);
CREATE INDEX IF NOT EXISTS idx_tool_platform_download_summaries_platform ON tool_platform_download_summaries(platform_id);
CREATE INDEX IF NOT EXISTS idx_tool_version_download_summaries_tool_downloads ON tool_version_download_summaries(tool_id, downloads_all_time DESC);
CREATE INDEX IF NOT EXISTS idx_backend_tool_summaries_count ON backend_tool_summaries(tool_count DESC, backend_type);
CREATE INDEX IF NOT EXISTS idx_trending_tool_summaries_score ON trending_tool_summaries(trending_score DESC, tool_id);

-- Insert tools
`);

tools.forEach((tool, i) => {
  console.log(
    `INSERT OR IGNORE INTO tools (id, name) VALUES (${i + 1}, '${tool}');`,
  );
});

console.log("\n-- Insert backends");
backends.forEach((backend, i) => {
  console.log(
    `INSERT OR IGNORE INTO backends (id, full) VALUES (${i + 1}, '${backend}:default');`,
  );
});

console.log("\n-- Insert platforms");
console.log(
  `INSERT OR IGNORE INTO platforms (id, os, arch) VALUES (1, 'macos', 'arm64');`,
);
console.log(
  `INSERT OR IGNORE INTO platforms (id, os, arch) VALUES (2, 'macos', 'x64');`,
);
console.log(
  `INSERT OR IGNORE INTO platforms (id, os, arch) VALUES (3, 'linux', 'x64');`,
);
console.log(
  `INSERT OR IGNORE INTO platforms (id, os, arch) VALUES (4, 'linux', 'arm64');`,
);
console.log(
  `INSERT OR IGNORE INTO platforms (id, os, arch) VALUES (5, 'windows', 'x64');`,
);

// Generate dates for the last 45 days
const now = Date.now();
const day = 24 * 60 * 60 * 1000;

console.log("\n-- Insert daily stats (last 45 days)");
for (let d = 0; d < 45; d++) {
  const date = new Date(now - d * day);
  const dateStr = date.toISOString().split("T")[0];
  const totalDownloads = Math.floor(Math.random() * 5000) + 1000;
  const uniqueUsers = Math.floor(totalDownloads * 0.4);
  console.log(
    `INSERT OR REPLACE INTO daily_stats (date, total_downloads, unique_users) VALUES ('${dateStr}', ${totalDownloads}, ${uniqueUsers});`,
  );
}

console.log("\n-- Insert daily tool stats");
for (let d = 0; d < 45; d++) {
  const date = new Date(now - d * day);
  const dateStr = date.toISOString().split("T")[0];

  tools.forEach((tool, toolIdx) => {
    // Popular tools get more downloads
    const baseDownloads = toolIdx < 5 ? 200 : toolIdx < 10 ? 100 : 50;
    const downloads =
      Math.floor(Math.random() * baseDownloads) + Math.floor(baseDownloads / 2);
    const uniqueUsers = Math.floor(downloads * 0.4);
    console.log(
      `INSERT OR REPLACE INTO daily_tool_stats (date, tool_id, downloads, unique_users) VALUES ('${dateStr}', ${toolIdx + 1}, ${downloads}, ${uniqueUsers});`,
    );
  });
}

const thirtyDaysAgo = new Date(now - 30 * day).toISOString().split("T")[0];
console.log("\n-- Insert tool download summaries");
console.log(`
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
  WHERE date >= '${thirtyDaysAgo}'
  GROUP BY tool_id
)
SELECT
  t.id,
  COALESCE(r.downloads_30d, 0),
  COALESCE(a.downloads_all_time, 0),
  '${new Date(now).toISOString()}'
FROM tools t
LEFT JOIN all_time a ON a.tool_id = t.id
LEFT JOIN recent r ON r.tool_id = t.id;
`);

console.log("\n-- Insert daily backend stats");
for (let d = 0; d < 45; d++) {
  const date = new Date(now - d * day);
  const dateStr = date.toISOString().split("T")[0];

  backends.forEach((backend, _) => {
    const downloads = Math.floor(Math.random() * 500) + 100;
    const uniqueUsers = Math.floor(downloads * 0.4);
    console.log(
      `INSERT OR REPLACE INTO daily_backend_stats (date, backend_type, downloads, unique_users) VALUES ('${dateStr}', '${backend}', ${downloads}, ${uniqueUsers});`,
    );
  });
}
