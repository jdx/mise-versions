import { writeFile } from "node:fs/promises";
import { parseProjects, parseComparison } from "../web/src/lib/project-stats";
const base = "https://raw.githubusercontent.com/jdx/mise-analytics/main/";
async function get(url: string, api = false): Promise<Response> {
  const token = process.env.GH_TOKEN;
  const response = await fetch(url, {
    headers: api && token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
}
const files = [
  "top-repos-list.txt",
  "top-repos.csv",
  "top-repos-downloads.csv",
  "hk-competitors.csv",
  "fnox-competitors.csv",
  "aube-competitors.csv",
];
const contents = await Promise.all(
  files.map(async (f) => (await get(base + f)).text()),
);
const projects = parseProjects(contents[0], contents[1], contents[2]);
if (projects.length < 3)
  throw new Error("Project data unexpectedly incomplete");
const comparisons = ["hk", "fnox", "aube"].map((name, i) =>
  parseComparison(name, contents[i + 3]),
);
if (comparisons.some((c) => c.series.some((s) => !s.points.length)))
  throw new Error("Comparison data incomplete");
const cutoff =
  new Date(Date.now() - 370 * 86400000).toISOString().slice(0, 7) + "-01";
const monthly = new Map<string, { date: string; label: string; url: string }>();
// GitHub returns newest releases first. Fetch until the full history window is covered.
let complete = false;
for (let page = 1; page <= 20; page++) {
  const releases = (await (
    await get(
      `https://api.github.com/repos/jdx/mise/releases?per_page=100&page=${page}`,
      true,
    )
  ).json()) as Array<{
    draft: boolean;
    prerelease: boolean;
    tag_name: string;
    published_at: string;
    html_url: string;
  }>;
  if (!Array.isArray(releases)) throw new Error("Invalid release response");
  for (const r of releases) {
    if (
      r.draft ||
      r.prerelease ||
      !r.published_at ||
      !/^v?\d+\.\d+\.\d+$/.test(r.tag_name)
    )
      continue;
    const date = r.published_at.slice(0, 10);
    if (date < cutoff) continue;
    const month = date.slice(0, 7),
      previous = monthly.get(month);
    if (!previous || date < previous.date)
      monthly.set(month, {
        date,
        label: `mise ${r.tag_name}`,
        url: r.html_url,
      });
  }
  if (
    releases.length < 100 ||
    releases.every(
      (r) => r.published_at && r.published_at.slice(0, 10) < cutoff,
    )
  ) {
    complete = true;
    break;
  }
}
if (!complete)
  throw new Error("Release pagination limit reached; snapshot not written");
await writeFile(
  new URL("../web/src/data/projects.json", import.meta.url),
  JSON.stringify({ projects, comparisons }, null, 2) + "\n",
);
await writeFile(
  new URL("../web/src/data/mise-events.json", import.meta.url),
  JSON.stringify(
    [...monthly.values()].sort((a, b) => a.date.localeCompare(b.date)),
    null,
    2,
  ) + "\n",
);
console.log(
  `Saved ${projects.length} projects, ${comparisons.length} comparisons, ${monthly.size} monthly release markers`,
);
