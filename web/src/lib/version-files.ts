import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import {
  getCachedText as getKvCachedText,
  putCachedText as putKvCachedText,
} from "./kv-cache";

type Db = ReturnType<typeof drizzle>;

export interface VersionRow {
  version: string;
  created_at: string | null;
  release_url: string | null;
  prerelease: number;
}

const VERSION_FILE_TTL_SECONDS = 600;

function cacheKey(request: Request, suffix: string): Request {
  const url = new URL(request.url);
  url.search = "";
  url.hash = "";
  url.pathname = `${url.pathname}${suffix}`;
  return new Request(url.toString(), { method: "GET" });
}

export async function getCachedText(
  request: Request,
  suffix: string,
): Promise<string | null> {
  const cache = (globalThis.caches as CacheStorage & { default?: Cache })
    ?.default;
  if (!cache) return null;

  const response = await cache.match(cacheKey(request, suffix));
  return response?.ok ? response.text() : null;
}

export async function putCachedText(
  request: Request,
  suffix: string,
  text: string,
  contentType: string,
): Promise<void> {
  const cache = (globalThis.caches as CacheStorage & { default?: Cache })
    ?.default;
  if (!cache) return;

  await cache.put(
    cacheKey(request, suffix),
    new Response(text, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": `public, max-age=${VERSION_FILE_TTL_SECONDS}`,
      },
    }),
  );
}

function versionRowsCacheKey(
  tool: string,
  options: { stableOnly?: boolean } = {},
): string {
  return `version-rows:${options.stableOnly ? "stable" : "all"}:${encodeURIComponent(tool).replace(/\./g, "%2E")}`;
}

export async function getCachedVersionRows(
  kv: KVNamespace,
  tool: string,
  options: { stableOnly?: boolean } = {},
): Promise<VersionRow[] | null> {
  const cached = await getKvCachedText(kv, versionRowsCacheKey(tool, options));
  return cached ? (JSON.parse(cached) as VersionRow[]) : null;
}

export async function putCachedVersionRows(
  kv: KVNamespace,
  tool: string,
  options: { stableOnly?: boolean } = {},
  rows: VersionRow[],
): Promise<void> {
  await putKvCachedText(
    kv,
    versionRowsCacheKey(tool, options),
    JSON.stringify(rows),
    VERSION_FILE_TTL_SECONDS,
  );
}

export async function loadVersionRows(
  db: Db,
  tool: string,
  options: { stableOnly?: boolean } = {},
): Promise<VersionRow[] | null> {
  const toolRow = await db.get<{ id: number }>(sql`
    SELECT id
    FROM tools
    WHERE name = ${tool}
  `);

  if (!toolRow) return null;

  const stableFilter = options.stableOnly ? sql`AND prerelease = 0` : sql``;
  const rows = await db.all<{
    version: string;
    created_at: string | null;
    release_url: string | null;
    prerelease: number;
  }>(sql`
    SELECT
      version,
      created_at,
      release_url,
      prerelease
    FROM versions
    WHERE tool_id = ${toolRow.id}
      AND from_mise = 1
      ${stableFilter}
    ORDER BY sort_order ASC, id ASC
  `);

  return rows.map((row) => ({
    version: row.version,
    created_at: row.created_at,
    release_url: row.release_url,
    prerelease: row.prerelease,
  }));
}

export function versionsToText(versions: Pick<VersionRow, "version">[]) {
  return versions.length > 0
    ? `${versions.map((v) => v.version).join("\n")}\n`
    : "";
}

export function versionsToToml(versions: VersionRow[]) {
  const lines = ["[versions]"];

  for (const v of versions) {
    const parts: string[] = [];
    if (v.created_at) {
      parts.push(`created_at = ${v.created_at}`);
    }
    if (v.release_url) {
      parts.push(`release_url = "${v.release_url}"`);
    }
    if (v.prerelease === 1) {
      parts.push("prerelease = true");
    }

    lines.push(
      parts.length > 0
        ? `"${v.version}" = { ${parts.join(", ")} }`
        : `"${v.version}" = {}`,
    );
  }

  return `${lines.join("\n")}\n`;
}
