// Report which baked GitHub version lists mise clients fetched on a day, so
// the Worker keeps baking them (see scripts/bake-github-versions.js and
// /api/admin/github/versions/demand).

// The endpoint takes at most this many paths per call.
export const DEMAND_BATCH = 400;

export async function reportGithubVersionsDemand({
  apiUrl,
  secret,
  date,
  paths,
  fetchImpl = fetch,
}) {
  const totals = { paths: paths.length, stamped: 0, unknown: 0 };
  const sorted = [...paths].sort();
  for (let i = 0; i < sorted.length; i += DEMAND_BATCH) {
    const response = await fetchImpl(
      `${apiUrl}/api/admin/github/versions/demand`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          date,
          paths: sorted.slice(i, i + DEMAND_BATCH),
        }),
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
  return totals;
}
