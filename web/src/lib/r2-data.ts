// R2 data access utilities

export interface R2DataResult {
  body: ReadableStream;
  contentType: string;
}

/**
 * Get a file from R2 bucket as a stream
 */
export async function getFromR2(
  bucket: R2Bucket,
  key: string,
): Promise<R2DataResult | null> {
  const object = await bucket.get(key);
  if (!object) {
    return null;
  }

  // Determine content type from key or object metadata
  let contentType =
    object.httpMetadata?.contentType || "application/octet-stream";
  if (!object.httpMetadata?.contentType) {
    if (key.endsWith(".toml")) contentType = "text/plain; charset=utf-8";
    else if (key.endsWith(".json")) contentType = "application/json";
    else if (key.endsWith(".png")) contentType = "image/png";
  }

  return {
    body: object.body,
    contentType,
  };
}

/**
 * Get a file from R2 bucket as text
 */
export async function getTextFromR2(
  bucket: R2Bucket,
  key: string,
): Promise<string | null> {
  const object = await bucket.get(key);
  if (!object) {
    return null;
  }
  return object.text();
}

/**
 * Get a file from R2 bucket and parse as JSON
 */
export async function getJsonFromR2<T>(
  bucket: R2Bucket,
  key: string,
): Promise<T | null> {
  const text = await getTextFromR2(bucket, key);
  if (!text) {
    return null;
  }
  return JSON.parse(text) as T;
}
