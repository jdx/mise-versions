// Retry wrapper for sync API calls.
// Retries on network errors, 5xx, and 404 (worker cold-start / deploy races
// against mise-tools.jdx.dev have been observed returning 404 intermittently).
// Other 4xx responses are treated as fatal since retrying won't help.
export async function fetchWithRetry(
  url,
  init,
  { attempts = 4, baseDelayMs = 2000 } = {},
) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;

      const body = await res.text().catch(() => "");
      const msg = `${res.status} ${res.statusText}: ${body.slice(0, 200)}`;

      if (res.status >= 500 || res.status === 404) {
        throw new Error(msg);
      }
      // Non-retriable 4xx
      const err = new Error(msg);
      err.status = res.status;
      err.body = body;
      err.fatal = true;
      throw err;
    } catch (e) {
      lastErr = e;
      if (e.fatal || i === attempts - 1) break;
      const delay = baseDelayMs * Math.pow(2, i);
      console.warn(
        `fetch ${url} attempt ${i + 1}/${attempts} failed: ${e.message}. Retrying in ${delay}ms...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
