import { sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";

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

export async function loadVersionRows(
  db: Db,
  tool: string,
  options: { stableOnly?: boolean } = {},
): Promise<VersionRow[] | null> {
  const rows = await db.all<{
    tool_id: number;
    version: string | null;
    created_at: string | null;
    release_url: string | null;
    prerelease: number | null;
  }>(sql`
    SELECT
      t.id as tool_id,
      v.version,
      v.created_at,
      v.release_url,
      v.prerelease
    FROM tools t
    LEFT JOIN versions v
      ON v.tool_id = t.id
      AND v.from_mise = 1
      AND (${options.stableOnly ? 1 : 0} = 0 OR v.prerelease = 0)
    WHERE t.name = ${tool}
    ORDER BY v.sort_order ASC, v.id ASC
  `);

  if (rows.length === 0) return null;

  return rows
    .filter((row) => row.version !== null)
    .map((row) => ({
      version: row.version!,
      created_at: row.created_at,
      release_url: row.release_url,
      prerelease: row.prerelease ?? 0,
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
