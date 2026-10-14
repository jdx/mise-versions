// Minimal R2 client over the S3 API (AWS Signature Version 4), enough to list,
// read, and write objects from GitHub Actions without an SDK dependency.

import { createHash, createHmac } from "node:crypto";

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const RETRY_ATTEMPTS = 4;
const FETCH_TIMEOUT_MS = 120_000;

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

// RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()*).
export function uriEncode(value, keepSlash = false) {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return keepSlash ? encoded.replaceAll("%2F", "/") : encoded;
}

function amzDate(now) {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

// Returns the headers (including Authorization) for a SigV4-signed request.
// `path` is the unencoded object path, e.g. `/bucket/some key`.
export function signRequest({
  method,
  host,
  path,
  query = {},
  headers = {},
  payloadHash = EMPTY_SHA256,
  accessKeyId,
  secretAccessKey,
  region = "auto",
  service = "s3",
  now = new Date(),
}) {
  const timestamp = amzDate(now);
  const date = timestamp.slice(0, 8);
  const allHeaders = {
    ...Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
    ),
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": timestamp,
  };
  const headerNames = Object.keys(allHeaders).sort();
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${allHeaders[name].trim()}\n`)
    .join("");
  const signedHeaders = headerNames.join(";");
  const canonicalQuery = Object.entries(query)
    .map(([k, v]) => [uriEncode(k), uriEncode(String(v))])
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [
    method,
    uriEncode(path, true),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");
  return {
    ...allHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function parseListObjectsV2(xml) {
  const objects = [];
  for (const [, body] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(body)?.[1];
    if (key !== undefined) {
      objects.push({ key: decodeXml(key), size: Number(size ?? 0) });
    }
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const token =
    /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return {
    objects,
    nextToken: truncated && token ? decodeXml(token) : null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class R2Client {
  constructor({ accountId, accessKeyId, secretAccessKey, bucket, endpoint }) {
    for (const [name, value] of Object.entries({
      accessKeyId,
      secretAccessKey,
      bucket,
    })) {
      if (!value) throw new Error(`R2 ${name} is required`);
    }
    if (!endpoint && !accountId) {
      throw new Error("R2 accountId or endpoint is required");
    }
    this.endpoint = new URL(
      endpoint || `https://${accountId}.r2.cloudflarestorage.com`,
    );
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.bucket = bucket;
  }

  async request(method, key, { query = {}, body, contentType } = {}) {
    const path = key ? `/${this.bucket}/${key}` : `/${this.bucket}`;
    const url = new URL(this.endpoint);
    url.pathname = uriEncode(path, true);
    url.search = new URLSearchParams(query).toString();
    for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
      const headers = signRequest({
        method,
        host: url.host,
        path,
        query,
        headers: contentType ? { "content-type": contentType } : {},
        payloadHash: body ? sha256Hex(body) : EMPTY_SHA256,
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      });
      delete headers.host;
      let response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt === RETRY_ATTEMPTS) throw error;
        await sleep(2 ** attempt * 1000);
        continue;
      }
      if (response.status === 404 && method === "GET" && key) return null;
      if (response.ok) return response;
      const text = await response.text().catch(() => "");
      const message = `R2 ${method} ${path} failed ${response.status}: ${text.slice(0, 300)}`;
      if (
        attempt < RETRY_ATTEMPTS &&
        (response.status === 429 || response.status >= 500)
      ) {
        console.warn(`${message}; retrying`);
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw new Error(message);
    }
    throw new Error(`R2 ${method} ${path} failed after retries`);
  }

  async listObjects(prefix) {
    const objects = [];
    let token = null;
    do {
      const query = { "list-type": "2", prefix };
      if (token) query["continuation-token"] = token;
      const response = await this.request("GET", "", { query });
      const page = parseListObjectsV2(await response.text());
      objects.push(...page.objects);
      token = page.nextToken;
    } while (token);
    return objects;
  }

  // The whole object as a Buffer, or null if it does not exist. Logpush
  // objects are a few MB compressed, so buffering one at a time is cheap.
  async getObject(key) {
    const response = await this.request("GET", key);
    if (!response) return null;
    return Buffer.from(await response.arrayBuffer());
  }

  async putObject(key, body, contentType = "application/octet-stream") {
    await this.request("PUT", key, { body, contentType });
  }
}
