const TEXT_DECODER = new TextDecoder();

export function keyPart(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function requestCacheKey(
  prefix: string,
  url: URL | Request | string,
): Promise<string> {
  const value =
    typeof url === "string" ? url : url instanceof Request ? url.url : url.href;
  return `response-cache:${prefix}:${await sha256(value)}`;
}

export async function getCachedJson<T>(
  kv: KVNamespace,
  key: string,
): Promise<T | null> {
  const value = await kv.get(key, "arrayBuffer");
  if (!value) return null;

  return JSON.parse(TEXT_DECODER.decode(value)) as T;
}

export async function putCachedJson(
  kv: KVNamespace,
  key: string,
  value: unknown,
  expirationTtl: number,
): Promise<void> {
  await kv.put(key, JSON.stringify(value), { expirationTtl });
}

export async function getCachedText(
  kv: KVNamespace,
  key: string,
): Promise<string | null> {
  return kv.get(key);
}

export async function putCachedText(
  kv: KVNamespace,
  key: string,
  value: string,
  expirationTtl: number,
): Promise<void> {
  await kv.put(key, value, { expirationTtl });
}
