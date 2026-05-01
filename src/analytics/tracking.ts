// Tracking functions for downloads and version requests
import type { drizzle } from "drizzle-orm/d1";
import { sql, eq, and } from "drizzle-orm";
import {
  tools,
  backends,
  platforms,
  downloads,
  versionRequests,
} from "./schema.js";
import { keyPart } from "../../web/src/lib/kv-cache.js";

// Caches for ID lookups (shared within the tracking module)
const toolCache = new Map<string, number>();
const backendCache = new Map<string, number>();
const platformCache = new Map<string, number>();

const ID_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const DAILY_DEDUPE_TTL_SECONDS = 2 * 24 * 60 * 60;

type TrackingCache = {
  kv?: KVNamespace;
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

function dailyDedupeKey(name: string, ipHash: string): string {
  const day = Math.floor(Date.now() / 86400000);
  return `tracking-dedupe:${name}:${day}:${ipHash}`;
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

    // Track a version request (for mise DAU/MAU) with daily deduplication per IP
    async trackVersionRequest(
      ipHash: string,
    ): Promise<{ deduplicated: boolean }> {
      const now = Math.floor(Date.now() / 1000);
      const todayStart = Math.floor(now / 86400) * 86400; // Start of today (UTC)

      if (cache.kv) {
        const key = dailyDedupeKey("version-request", ipHash);
        const seen = await cache.kv.get(key);
        if (seen) {
          return { deduplicated: true };
        }

        await cache.kv.put(key, "1", {
          expirationTtl: DAILY_DEDUPE_TTL_SECONDS,
        });

        await db.insert(versionRequests).values({
          ip_hash: ipHash,
          created_at: now,
        });

        return { deduplicated: false };
      }

      // Check if already tracked today for this IP
      const existing = await db
        .select()
        .from(versionRequests)
        .where(
          and(
            eq(versionRequests.ip_hash, ipHash),
            sql`${versionRequests.created_at} >= ${todayStart}`,
          ),
        )
        .limit(1)
        .get();

      if (existing) {
        return { deduplicated: true };
      }

      // Insert new record
      await db.insert(versionRequests).values({
        ip_hash: ipHash,
        created_at: now,
      });

      return { deduplicated: false };
    },

    // Track a download with daily deduplication per IP/tool/version
    async trackDownload(
      tool: string,
      version: string,
      ipHash: string,
      os: string | null,
      arch: string | null,
      full: string | null = null, // Full backend identifier (e.g., "aqua:nektos/act")
    ): Promise<{ deduplicated: boolean }> {
      const toolId = await getOrCreateToolId(tool);
      const backendId = await getOrCreateBackendId(full);
      const platformId = await getOrCreatePlatformId(os, arch);
      const now = Math.floor(Date.now() / 1000);

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
  };
}
