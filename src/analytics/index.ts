// Analytics module - main entry point
// Composes all analytics functions and re-exports schema/types

import { drizzle } from "drizzle-orm/d1";
import { runAnalyticsMigrations } from "./migrations.js";
import { createTrackingFunctions } from "./tracking.js";
import { createStatsFunctions } from "./stats.js";
import { createBackendStatsFunctions } from "./backend-stats.js";
import { createTrendsFunctions } from "./trends.js";
import { createRollupFunctions } from "./rollups.js";
import { createGrowthFunctions } from "./growth.js";
import { createVersionsFunctions } from "./versions.js";
import { createMaintenanceFunctions } from "./maintenance.js";

// Re-export schema tables for external use
export {
  tools,
  backends,
  platforms,
  downloads,
  downloadsDaily,
  dailyStats,
  dailyToolStats,
  dailyBackendStats,
  dailyToolBackendStats,
  versionRequests,
  dailyVersionStats,
  dailyCombinedStats,
  dailyMauStats,
  versionUpdates,
} from "./schema.js";

// Re-export migrations
export { runAnalyticsMigrations };

// Main factory function that composes all analytics functions
export function setupAnalytics(db: ReturnType<typeof drizzle>) {
  const tracking = createTrackingFunctions(db);
  const stats = createStatsFunctions(db);
  const backendStats = createBackendStatsFunctions(db);
  const trends = createTrendsFunctions(db);
  const rollups = createRollupFunctions(db);
  const growth = createGrowthFunctions(db);
  const versions = createVersionsFunctions(db);
  const maintenance = createMaintenanceFunctions(db);

  return {
    // Tracking functions
    trackDownload: tracking.trackDownload,
    trackVersionRequest: tracking.trackVersionRequest,
    getOrCreateToolId: tracking.getOrCreateToolId,
    getOrCreateBackendId: tracking.getOrCreateBackendId,
    getOrCreatePlatformId: tracking.getOrCreatePlatformId,

    // Stats functions
    getDownloadStats: stats.getDownloadStats,
    getTopTools: stats.getTopTools,
    getAll30DayDownloads: stats.getAll30DayDownloads,
    getMAU: stats.getMAU,

    // Backend stats functions
    getDownloadsByBackend: backendStats.getDownloadsByBackend,
    getTopToolsByBackend: backendStats.getTopToolsByBackend,
    getBackendStats: backendStats.getBackendStats,

    // Trends functions
    getTrendingTools: trends.getTrendingTools,
    getToolGrowth: trends.getToolGrowth,
    getBatchSparklines: trends.getBatchSparklines,
    getVersionTrends: trends.getVersionTrends,
    getDAUMAUHistory: trends.getDAUMAUHistory,

    // Rollup functions
    populateRollupTables: rollups.populateRollupTables,
    populateDailyMauStats: rollups.populateDailyMauStats,
    populateVersionStatsRollup: rollups.populateVersionStatsRollup,
    backfillRollupTables: rollups.backfillRollupTables,

    // Growth functions
    getGrowthMetrics: growth.getGrowthMetrics,

    // Version functions
    getMiseDAUMAU: versions.getMiseDAUMAU,
    recordVersionUpdates: versions.recordVersionUpdates,
    getVersionUpdates: versions.getVersionUpdates,

    // Maintenance functions
    aggregateOldData: maintenance.aggregateOldData,
    backfillBackends: maintenance.backfillBackends,
    makeBackendIdNotNull: maintenance.makeBackendIdNotNull,
  };
}
