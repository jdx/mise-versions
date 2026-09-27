// Tracking functions for downloads and version requests
import type { drizzle } from "drizzle-orm/d1";
import { sql, eq, and } from "drizzle-orm";
import { tools, backends, platforms } from "./schema.js";
import { keyPart } from "../../web/src/lib/kv-cache.js";
import {
  writeDownloadEvent,
  writeVersionRequestEvent,
} from "./analytics-engine.js";

// Caches for ID lookups (shared within the tracking module)
const toolCache = new Map<string, number>();
const backendCache = new Map<string, number>();
const platformCache = new Map<string, number>();

const ID_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

type TrackingCache = {
  kv?: KVNamespace;
  events?: AnalyticsEngineDataset;
};

async function getCachedId(
  cache: TrackingCache,
  key: string,
): Promise<number | null> {
  if (!cache.kv) return null;

  const value = await cache.kv.get(key);
  if (!value) return null;

  const id = Number(value);
  return Number.isInteger(id) ? id : null;
}

async function putCachedId(
  cache: TrackingCache,
  key: string,
  id: number,
): Promise<void> {
  if (!cache.kv) return;

  await cache.kv.put(key, String(id), {
    expirationTtl: ID_CACHE_TTL_SECONDS,
  });
}

export function createTrackingFunctions(
  db: ReturnType<typeof drizzle>,
  cache: TrackingCache = {},
) {
  async function getOrCreateToolId(name: string): Promise<number> {
    // Check cache first
    if (toolCache.has(name)) {
      return toolCache.get(name)!;
    }

    const cacheKey = `tracking-id:tool:${keyPart(name)}`;
    const cachedId = await getCachedId(cache, cacheKey);
    if (cachedId) {
      toolCache.set(name, cachedId);
      return cachedId;
    }

    // Try to find existing
    const existing = await db
      .select({ id: tools.id })
      .from(tools)
      .where(eq(tools.name, name))
      .get();

    if (existing) {
      toolCache.set(name, existing.id);
      await putCachedId(cache, cacheKey, existing.id);
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
    await putCachedId(cache, cacheKey, id);
    return id;
  }

  async function getOrCreateBackendId(
    full: string | null,
  ): Promise<number | null> {
    if (!full) return null;

    // Check cache first
    if (backendCache.has(full)) {
      return backendCache.get(full)!;
    }

    const cacheKey = `tracking-id:backend:${keyPart(full)}`;
    const cachedId = await getCachedId(cache, cacheKey);
    if (cachedId) {
      backendCache.set(full, cachedId);
      return cachedId;
    }

    // Try to find existing
    const existing = await db
      .select({ id: backends.id })
      .from(backends)
      .where(eq(backends.full, full))
      .get();

    if (existing) {
      backendCache.set(full, existing.id);
      await putCachedId(cache, cacheKey, existing.id);
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
    await putCachedId(cache, cacheKey, id);
    return id;
  }

  async function getOrCreatePlatformId(
    os: string | null,
    arch: string | null,
  ): Promise<number | null> {
    if (!os && !arch) return null;

    const key = `${os || ""}:${arch || ""}`;
    if (platformCache.has(key)) {
      return platformCache.get(key)!;
    }

    const cacheKey = `tracking-id:platform:${keyPart(os || "")}:${keyPart(
      arch || "",
    )}`;
    const cachedId = await getCachedId(cache, cacheKey);
    if (cachedId) {
      platformCache.set(key, cachedId);
      return cachedId;
    }

    // Try to find existing
    const existing = await db
      .select({ id: platforms.id })
      .from(platforms)
      .where(
        and(
          os ? eq(platforms.os, os) : sql`${platforms.os} IS NULL`,
          arch ? eq(platforms.arch, arch) : sql`${platforms.arch} IS NULL`,
        ),
      )
      .get();

    if (existing) {
      platformCache.set(key, existing.id);
      await putCachedId(cache, cacheKey, existing.id);
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
          arch ? eq(platforms.arch, arch) : sql`${platforms.arch} IS NULL`,
        ),
      )
      .get();

    const id = inserted!.id;
    platformCache.set(key, id);
    await putCachedId(cache, cacheKey, id);
    return id;
  }

  return {
    // Expose cache helpers for other modules
    getOrCreateToolId,
    getOrCreateBackendId,
    getOrCreatePlatformId,

    // Track a version request (for mise DAU/MAU). Events go to Analytics
    // Engine and unique users are counted by the scheduled rollups, so nothing
    // is deduplicated at write time. Without the Analytics Engine binding the
    // event is dropped.
    async trackVersionRequest(
      ipHash: string,
    ): Promise<{ deduplicated: boolean }> {
      writeVersionRequestEvent(cache.events, ipHash);
      return { deduplicated: false };
    },

    // Track a download. Events go to Analytics Engine; per-IP/tool/version
    // deduplication happens in the scheduled rollups, so nothing is
    // deduplicated at write time. Without the Analytics Engine binding the
    // event is dropped.
    async trackDownload(
      tool: string,
      version: string,
      ipHash: string,
      os: string | null,
      arch: string | null,
      full: string | null = null, // Full backend identifier (e.g., "aqua:nektos/act")
    ): Promise<{ deduplicated: boolean }> {
      // Record the event first so a D1 failure below cannot lose it.
      writeDownloadEvent(cache.events, {
        tool,
        version,
        ipHash,
        os,
        arch,
        full,
      });

      // Keep dimension tables populated even though raw events live in
      // Analytics Engine; scheduled rollups resolve tool/platform names back
      // to these ids before materializing D1 summaries.
      await getOrCreateToolId(tool);
      await getOrCreateBackendId(full);
      await getOrCreatePlatformId(os, arch);
      return { deduplicated: false };
    },
  };
}
