// Refresh public adoption data and verified vendor manifests. Run with tsx.
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  summarizePackslip,
  type PackslipMetadata,
} from "../web/src/lib/packslip-manifest";
import {
  parseStarCsv,
  parseMiseDownloadsCsv,
} from "../web/src/lib/mise-growth";
import { parseAdoptionCsv } from "../web/src/lib/mise-adoption";

const data = new URL("../web/src/data/", import.meta.url);
const token = process.env.GH_TOKEN;
async function get(url: string, github = false) {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(url, {
      headers: github && token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 429 && response.status < 500) break;
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
  if (!response) throw new Error(`No response from ${url}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}
const previous: Record<string, PackslipMetadata> = JSON.parse(
  await readFile(new URL("packslip.json", data), "utf8").catch(() => "{}"),
);
const catalog = { ...previous };
const repos = new Set<string>();
const explicit = process.argv.slice(2);
if (explicit.length) explicit.forEach((repo) => repos.add(repo));
else {
  Object.keys(previous).forEach((repo) => repos.add(repo));
  for (let page = 1; ; page++) {
    const response = await get(
      `https://mise-versions.jdx.dev/api/tools?limit=100&sort=name&page=${page}`,
    );
    if (!response) throw new Error("Tool directory unavailable");
    const result: any = await response.json();
    if (
      !Array.isArray(result.tools) ||
      !Number.isInteger(result.total_pages) ||
      result.total_pages < 1
    )
      throw new Error("Invalid tool directory response");
    for (const tool of result.tools) {
      if (
        typeof tool.github === "string" &&
        /^[\w.-]+\/[\w.-]+$/.test(tool.github)
      )
        repos.add(tool.github);
    }
    if (page >= result.total_pages) break;
  }
}
const dir = await mkdtemp(join(tmpdir(), "mise-packslip-"));
let failures = 0;
try {
  for (const repo of [...repos].sort()) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new Error(`Invalid repository: ${repo}`);
    try {
      const response = await get(
        `https://api.github.com/repos/${repo}/releases/latest`,
        true,
      );
      const release: any = response ? await response.json() : null;
      const asset = release?.assets?.find(
        (a: any) => a.name === "packslip.sigstore.json",
      );
      if (!asset) {
        delete catalog[repo];
        continue;
      }
      // GitHub resolves repository transfers (e.g. jdx/aube -> aubepkg/aube).
      // Bind trust to the canonical repository from its API, never the manifest.
      const canonicalRepo = release.url?.match(
        /^https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+)\/releases\/\d+$/,
      )?.[1];
      if (!canonicalRepo) throw new Error("Unexpected release API URL");
      const expectedPrefix = `https://github.com/${canonicalRepo}/releases/download/`;
      if (!asset.browser_download_url.startsWith(expectedPrefix))
        throw new Error("Unexpected asset URL");
      const bundle = await get(asset.browser_download_url);
      if (!bundle) throw new Error("Manifest asset disappeared");
      const raw = await bundle.text();
      if (raw.length > 5_000_000) throw new Error("Manifest too large");
      const path = join(dir, "bundle.json");
      await writeFile(path, raw);
      const verified = JSON.parse(
        execFileSync(
          process.env.PACKSLIP_BIN || "packslip",
          [
            "verify",
            "--json",
            "--identity-prefix",
            `https://github.com/${canonicalRepo}/`,
            "--issuer",
            "https://token.actions.githubusercontent.com",
            path,
          ],
          { encoding: "utf8", timeout: 60_000, maxBuffer: 5_000_000 },
        ),
      );
      const statement = JSON.parse(
        Buffer.from(JSON.parse(raw).dsseEnvelope.payload, "base64").toString(
          "utf8",
        ),
      );
      // Domain and monorepo discovery need their own trust binding. Do not infer it.
      if (statement.predicate.project !== `github.com/${canonicalRepo}`) {
        delete catalog[repo];
        continue;
      }
      if (statement.predicate.source?.tag !== release.tag_name)
        throw new Error("Manifest source tag differs from the release");
      catalog[repo] = summarizePackslip(
        statement,
        verified,
        canonicalRepo,
        asset.browser_download_url,
        `https://github.com/${canonicalRepo}/releases/tag/${encodeURIComponent(release.tag_name)}`,
      );
      console.log(`${repo}: verified ${catalog[repo].version}`);
    } catch (error) {
      failures++;
      console.error(
        `${repo}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
// Fail closed: a failed refresh leaves the last reviewed snapshot intact.
if (failures)
  throw new Error(
    `${failures} repository refreshes failed; snapshot not written`,
  );
const response = await get(
  "https://raw.githubusercontent.com/jdx/mise-analytics/main/mise.csv",
);
if (!response) throw new Error("mise analytics unavailable");
const points = parseAdoptionCsv(await response.text());
if (!points.length)
  throw new Error("mise analytics contains no valid observations");
const extra = await Promise.all(
  ["competitors.csv", "top-repos-downloads.csv"].map(async (file) => {
    const response = await get(
      `https://raw.githubusercontent.com/jdx/mise-analytics/main/${file}`,
    );
    if (!response) throw new Error(`${file} unavailable`);
    return response.text();
  }),
);
const stars = parseStarCsv(extra[0]);
const downloads = parseMiseDownloadsCsv(extra[1]);
if (!stars.length || !downloads.length)
  throw new Error("Missing mise growth observations");
await writeFile(
  new URL("mise-stars.json", data),
  JSON.stringify(stars, null, 2) + "\n",
);
await writeFile(
  new URL("mise-downloads.json", data),
  JSON.stringify(downloads, null, 2) + "\n",
);
await writeFile(
  new URL("mise-adoption.json", data),
  JSON.stringify(points, null, 2) + "\n",
);
await writeFile(
  new URL("packslip.json", data),
  JSON.stringify(
    Object.fromEntries(
      Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)),
    ),
    null,
    2,
  ) + "\n",
);
console.log(
  `Saved ${points.length} adoption observations and ${Object.keys(catalog).length} verified manifests`,
);
