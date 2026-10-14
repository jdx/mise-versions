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
// Read-through loads in flight, per key, so a direct write (such as a
// generation rotation) can tell them their answer is older than its own. Only
// pending loads are tracked, so nothing outlives the load that added it.
interface LoadMark {
  superseded: boolean;
}
const loadMarks = new WeakMap<object, Map<string, Set<LoadMark>>>();

function markLoad(scope: object, key: string): LoadMark {
  let byKey = loadMarks.get(scope);
  if (!byKey) {
    byKey = new Map();
    loadMarks.set(scope, byKey);
  }
  let marks = byKey.get(key);
  if (!marks) {
    marks = new Set();
    byKey.set(key, marks);
  }
  const mark = { superseded: false };
  marks.add(mark);
  return mark;
}

function unmarkLoad(scope: object, key: string, mark: LoadMark): void {
  const byKey = loadMarks.get(scope);
  const marks = byKey?.get(key);
  if (!marks) return;
  marks.delete(mark);
  if (marks.size === 0) byKey!.delete(key);
}

function supersedeLoads(scope: object, key: string): void {
  for (const mark of loadMarks.get(scope)?.get(key) ?? []) {
    mark.superseded = true;
  }
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
  supersedeLoads(scope, key);
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
 *
 * When a shared load fails, its waiters retry it once between them. A failure
 * for which `callerSpecific` returns true (such as the caller's own rate
 * limit) is instead retried by each waiter with its own `load`, so one
 * client's failure is never handed to another.
 */
export async function readThroughMemo<T>(
  scope: object,
  key: string,
  load: () => Promise<MemoLoad<T>>,
  { callerSpecific }: { callerSpecific?: (error: unknown) => boolean } = {},
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
    } catch (error) {
      // The first waiter to see a shared failure starts the retry below; the
      // others join it rather than each calling `load` again.
      const retry = pending.get(key) as Promise<MemoLoad<T>> | undefined;
      if (!callerSpecific?.(error) && retry && retry !== existing) {
        try {
          return (await retry).value;
        } catch (retryError) {
          if (!callerSpecific?.(retryError)) throw retryError;
        }
      }
    }
  }

  const mark = markLoad(scope, key);
  const loading = (async () => {
    try {
      const loaded = await load();
      // A direct write while this load ran holds a newer value; keep it.
      if (!mark.superseded) {
        await writeMemo(scope, key, loaded.value, loaded.expiresAt);
      }
      return loaded;
    } finally {
      unmarkLoad(scope, key, mark);
    }
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
  pendingLoadKeys: (scope: object) => loadMarks.get(scope)?.size ?? 0,
};
