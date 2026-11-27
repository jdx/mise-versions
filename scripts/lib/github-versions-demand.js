// Report which baked GitHub version lists mise clients fetched on a day, so
// the Worker keeps baking them (see scripts/bake-github-versions.js and
// /api/admin/github/versions/demand).

// The endpoint takes at most this many paths per call.
export const DEMAND_BATCH = 400;

// Batches in flight at once. Each one makes the Worker read (and maybe
// write) KV for up to DEMAND_BATCH paths, ~13 s a batch, so one at a time
// cost the nightly rollup well over a minute a day.
export const DEMAND_CONCURRENCY = 4;

export async function reportGithubVersionsDemand({
  apiUrl,
  secret,
  date,
  paths,
  fetchImpl = fetch,
  concurrency = DEMAND_CONCURRENCY,
}) {
  const totals = { paths: paths.length, stamped: 0, unknown: 0 };
  const sorted = [...paths].sort();
  const batches = [];
  for (let i = 0; i < sorted.length; i += DEMAND_BATCH) {
    batches.push(sorted.slice(i, i + DEMAND_BATCH));
  }
  let next = 0;
  // After any batch fails, the others send nothing more, as when they went
  // one at a time, and the report rejects only once none is still in flight.
  let error;
  async function send(batch) {
    const response = await fetchImpl(
      `${apiUrl}/api/admin/github/versions/demand`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ date, paths: batch }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `demand report failed: HTTP ${response.status} ${await response.text()}`,
      );
    }
    const result = await response.json();
    totals.stamped += result.stamped ?? 0;
    totals.unknown += result.unknown ?? 0;
  }
  async function worker() {
    while (error === undefined && next < batches.length) {
      try {
        await send(batches[next++]);
      } catch (caught) {
        error ??= caught;
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), batches.length) },
      worker,
    ),
  );
  if (error !== undefined) throw error;
  return totals;
}
