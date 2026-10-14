// A free cache tier in front of GITHUB_CACHE (Workers KV) for small values
// that the GitHub mirror reads on every request. Every KV read is billed, even
// when KV answers from its own colo cache; Cache API reads are free.
//
// Two layers, both keyed by the KV key the value came from:
// - a module-scope map in this isolate, and
// - the colo's Cache API (`caches.default`), shared by the isolates there.
//
// Each entry carries an absolute expiry that the caller derives from the
// value's own lifetime, and neither layer serves an entry past it. A memo
// therefore never extends how long a value is trusted; it only skips the KV
// read while the value is still valid. Values that KV writes can replace
// before they expire must use a short expiry (see release-generation.ts).

// Bump the version when the stored shape changes; Cache API entries survive
// deploys.
const MEMO_URL_PREFIX = "https://mise-versions.jdx.dev/__mise/kv-memo/v1/";
const MAX_LOCAL_ENTRIES = 10_000;

interface LocalEntry {
  value: unknown;
  expiresAt: number;
}

interface StoredEntry {
  value: unknown;
  expires_at: number;
}

export interface Memo<T> {
  value: T;
  expiresAt: number;
}

export interface MemoLoad<T> {
  value: T;
  /** Epoch ms after which the value must not be served from the memo. */
  expiresAt: number;
}

// The in-isolate maps are scoped by KV binding object, so separate test stubs
// never share answers there. The edge (Cache API) tier is keyed by `key` alone,
// so it assumes every caller memoizes the same GITHUB_CACHE namespace.
const localMemos = new WeakMap<object, Map<string, LocalEntry>>();
const inflight = new WeakMap<object, Map<string, Promise<MemoLoad<unknown>>>>();
// Counts writes per key so a read-through load that started before a direct
// write (such as a generation rotation) does not overwrite the newer value.
const writeCounts = new WeakMap<object, Map<string, number>>();

function writeCount(scope: object, key: string): number {
  return writeCounts.get(scope)?.get(key) ?? 0;
}

function countWrite(scope: object, key: string): void {
  let counts = writeCounts.get(scope);
  if (!counts) {
    counts = new Map();
    writeCounts.set(scope, counts);
  }
  counts.set(key, writeCount(scope, key) + 1);
}

function localMemo(scope: object): Map<string, LocalEntry> {
  let memo = localMemos.get(scope);
  if (!memo) {
    memo = new Map();
    localMemos.set(scope, memo);
  }
  return memo;
}

function edgeCache(): Cache | undefined {
  try {
    return typeof caches === "undefined"
      ? undefined
      : (caches as unknown as { default?: Cache }).default;
  } catch {
    return undefined;
  }
}

function memoRequest(key: string): Request {
  return new Request(`${MEMO_URL_PREFIX}${encodeURIComponent(key)}`, {
    method: "GET",
  });
}

function setLocal(scope: object, key: string, entry: LocalEntry) {
  const memo = localMemo(scope);
  memo.delete(key);
  if (memo.size >= MAX_LOCAL_ENTRIES) {
    // Maps iterate in insertion order: drop the oldest entry.
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(key, entry);
}

/** The memoized value for `key`, or undefined when none exists or it has expired. */
export async function readMemo<T>(
  scope: object,
  key: string,
): Promise<Memo<T> | undefined> {
  const now = Date.now();
  const memo = localMemo(scope);
  const local = memo.get(key);
  if (local) {
    if (local.expiresAt > now) {
      return { value: local.value as T, expiresAt: local.expiresAt };
    }
    memo.delete(key);
  }

  const cache = edgeCache();
  if (!cache) return undefined;
  try {
    const response = await cache.match(memoRequest(key));
    if (!response) return undefined;
    const stored = (await response.json()) as StoredEntry;
    if (
      !stored ||
      typeof stored.expires_at !== "number" ||
      stored.expires_at <= Date.now()
    ) {
      return undefined;
    }
    setLocal(scope, key, {
      value: stored.value,
      expiresAt: stored.expires_at,
    });
    return { value: stored.value as T, expiresAt: stored.expires_at };
  } catch (error) {
    console.warn(`failed to read KV memo for ${key}:`, error);
    return undefined;
  }
}

/** Memoize `value` for `key` until `expiresAt` (epoch ms). */
export async function writeMemo<T>(
  scope: object,
  key: string,
  value: T,
  expiresAt: number,
): Promise<void> {
  const ttlSeconds = Math.floor((expiresAt - Date.now()) / 1000);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 1) return;
  countWrite(scope, key);
  setLocal(scope, key, { value, expiresAt });

  const cache = edgeCache();
  if (!cache) return;
  try {
    const stored: StoredEntry = { value, expires_at: expiresAt };
    await cache.put(
      memoRequest(key),
      new Response(JSON.stringify(stored), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${ttlSeconds}`,
        },
      }),
    );
  } catch (error) {
    console.warn(`failed to write KV memo for ${key}:`, error);
  }
}

/**
 * Serve `key` from the memo, or run `load` and memoize what it returns.
 * Concurrent misses in one isolate share a single `load`. Errors from `load`
 * propagate and are not memoized; a result whose `expiresAt` has passed is
 * returned but not memoized, and neither is one whose key was written directly
 * (with `writeMemo`) while the load ran.
 */
export async function readThroughMemo<T>(
  scope: object,
  key: string,
  load: () => Promise<MemoLoad<T>>,
): Promise<T> {
  const memo = await readMemo<T>(scope, key);
  if (memo) return memo.value;

  let pending = inflight.get(scope);
  if (!pending) {
    pending = new Map();
    inflight.set(scope, pending);
  }
  const existing = pending.get(key) as Promise<MemoLoad<T>> | undefined;
  if (existing) {
    try {
      return (await existing).value;
    } catch {
      // The shared load failed, possibly for a reason specific to the caller
      // that started it (such as its rate limit), so it is retried once. The
      // first waiter to see the failure starts the retry below; the others
      // join it rather than each calling `load` again.
      const retry = pending.get(key) as Promise<MemoLoad<T>> | undefined;
      if (retry && retry !== existing) return (await retry).value;
    }
  }

  const writesBefore = writeCount(scope, key);
  const loading = (async () => {
    const loaded = await load();
    // A direct write while this load ran holds a newer value; keep it.
    if (writeCount(scope, key) === writesBefore) {
      await writeMemo(scope, key, loaded.value, loaded.expiresAt);
    }
    return loaded;
  })();
  pending.set(key, loading);
  try {
    return (await loading).value;
  } finally {
    if (pending.get(key) === loading) pending.delete(key);
  }
}

export const __testing = {
  MEMO_URL_PREFIX,
  MAX_LOCAL_ENTRIES,
  memoRequest,
};
