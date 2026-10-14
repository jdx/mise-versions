#!/usr/bin/env node
/**
 * Build the static versions index served at /data/index.v1.json.
 *
 * The index lets a mise client resolve `latest` and common fuzzy prefixes
 * (`22`, `3.12`) for every tool with one request instead of downloading
 * /data/<tool>.toml per tool. The client contract is docs/versions-index.md;
 * keep the two in sync.
 *
 * For each tool the index holds an order-preserving subset of the entries in
 * /data/<tool>.toml plus coverage markers. The server never sorts or ranks
 * versions: the order is the one `mise ls-remote` printed (and the per-tool
 * file keeps), and the client runs its own matching, pre-release and
 * release-age rules over the subset. The coverage markers tell it when the
 * subset is guaranteed to give the same answer as the full list. Which entries
 * go in is a size/hit-rate heuristic; it never affects correctness.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

export const INDEX_FORMAT = 1;
export const INDEX_FILE = `index.v${INDEX_FORMAT}.json`;

/**
 * Release age the index is built to cover, from `generated_at`. Each run
 * extends back to a stable entry at least this old, so a client whose
 * `minimum_release_age` is at most this long usually finds its answer.
 */
export const HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Most entries one run (the tail or a prefix bucket) may take. 32 covers the
 * 99th percentile of entries a 7-day cutoff has to skip (27, measured over a
 * year of weekly snapshots of every tool); the rest are tools that publish
 * only pre-releases or non-numeric versions, which fall back.
 */
export const RUN_CAP = 32;
/** First-component keys (`22`) kept per tool, most recently listed first. */
export const MAX_MAJOR_KEYS = 16;
/** Second-component keys (`22.11`) kept per tool, most recently listed first. */
export const MAX_MINOR_KEYS = 8;

export const FLAG_ROLLING = 1;
export const FLAG_PRERELEASE = 2;

/** docs/*.toml files that are not tool version lists. */
const EXCLUDED_PREFIXES = ["python-precompiled"];

/**
 * mise's shared pre-release pattern (`VERSION_REGEX` in jdx/mise
 * src/plugins/mod.rs). Only used to decide where a run may stop, never to
 * drop entries.
 */
const VERSION_REGEX =
  /(^Available versions:|-src|[-\\.]dev|-latest|-stm|[-\\.]rc|-milestone|-alpha|-beta|[-\\.]pre|-next|-test|-nightly|-canary|-experimental|-insider|-edge|snapshot|SNAPSHOT|master|\d(?:alpha|beta|rc)\d*\b)/i;
/** mise's `PEP440_PRERELEASE_REGEX`, applied to the public version. */
const PEP440_PRERELEASE_REGEX =
  /[0-9][-_.]?(?:alpha|beta|preview|pre|rc|a|b|c|dev)[-_.]?[0-9]*(?:$|[^a-z0-9])/i;

const SEPARATORS = "+-.";
const startsWithDigit = (s) => /^[0-9]/.test(s);
const withoutV = (s) => (s.startsWith("v") ? s.slice(1) : s);

/**
 * Mirror of `fuzzy_version_matches(query, version)` in jdx/mise
 * src/backend/mod.rs. Keep it in step with that function.
 */
export function fuzzyVersionMatches(query, version) {
  if (query === "latest") {
    const v = withoutV(version);
    return startsWithDigit(v) && !v.includes("\n");
  }
  const queryWithoutV = /^[vV]/.test(query) ? query.slice(1) : null;
  const separators = startsWithDigit(queryWithoutV ?? query) ? "+-." : "-.";
  const continues = (literal, v) => {
    if (!v.startsWith(literal)) return false;
    const rest = v.slice(literal.length);
    if (query.endsWith("-")) return !rest.includes("\n");
    if (rest === "") return true;
    if (!separators.includes(rest[0])) return false;
    const tail = rest.slice(1);
    return tail !== "" && !tail.includes("\n");
  };
  if (continues(query, version)) return true;
  if (
    startsWithDigit(query) &&
    version.startsWith("v") &&
    continues(query, version.slice(1))
  ) {
    return true;
  }
  return queryWithoutV !== null && continues(queryWithoutV, version);
}

/**
 * The prefix keys a version contributes: the text before its first and second
 * separator (`+`, `-` or `.`), after an optional leading `v`, for versions that
 * start with a digit. `v22.11.0` gives `22` and `22.11`; `2024-01-15` gives
 * `2024` and `2024-01`; `3.12.0a1` gives `3` and `3.12`. Each key fuzzy-matches
 * the version it came from, and a key's matches are exactly the versions that
 * produce it plus versions spelled like the key itself (`22`, `v22`).
 */
export function prefixKeys(version) {
  const v = withoutV(version);
  if (!startsWithDigit(v) || v.includes("\n")) return [];
  const keys = [];
  for (let i = 1; i < v.length - 1 && keys.length < 2; i++) {
    // A key ending in a separator (from `1..2`) would read as a vendor prefix
    // like `temurin-`, which matches differently.
    if (SEPARATORS.includes(v[i]) && !SEPARATORS.includes(v[i - 1])) {
      keys.push(v.slice(0, i));
    }
  }
  return keys;
}

/**
 * Whether every mise backend treats this entry as a stable, concrete release:
 * it starts with a digit (after an optional `v`), is not a rolling channel,
 * and is not a pre-release by its flag, mise's shared pattern, or PEP 440.
 */
export function isGenericStable(entry) {
  const v = entry.version;
  if (!startsWithDigit(withoutV(v))) return false;
  if (entry.rolling || entry.prerelease) return false;
  return (
    !VERSION_REGEX.test(v) && !PEP440_PRERELEASE_REGEX.test(v.split("+")[0])
  );
}

/**
 * Take `positions` (ascending) from the end, stopping after the first stable
 * entry older than `cutoff`, after RUN_CAP entries, or at the start.
 */
function walkBack(entries, positions, cutoff) {
  const taken = [];
  for (let i = positions.length - 1; i >= 0; i--) {
    const entry = entries[positions[i]];
    taken.push(positions[i]);
    if (taken.length >= RUN_CAP) break;
    if (isGenericStable(entry) && entry.created_at < cutoff) break;
  }
  return taken;
}

/** The `max` keys whose last position is greatest. */
function mostRecentKeys(lastSeen, max) {
  return [...lastSeen]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key]) => key);
}

/**
 * Build the index entry for one tool.
 *
 * @param {{version: string, created_at: number, rolling?: boolean, prerelease?: boolean}[]} entries
 *   The tool's entries in /data/<tool>.toml order, `created_at` in epoch ms.
 * @param {{now: number}} options
 */
export function buildToolIndex(entries, { now }) {
  const cutoff = now - HORIZON_MS;
  const include = new Set();

  // Tail: a contiguous suffix of the full list.
  const tail = walkBack(
    entries,
    entries.map((_, i) => i),
    cutoff,
  );
  for (const p of tail) include.add(p);
  const tailStart = Math.min(...tail);

  // `find_match_in_list` answers a query with the query itself when it is a
  // listed version, so versions spelled like a key (or `latest`) must be in.
  const exact = new Map(entries.map((e, i) => [e.version, i]));
  if (exact.has("latest")) include.add(exact.get("latest"));

  const matches = new Map();
  const lastSeen = [new Map(), new Map()];
  entries.forEach((e, i) => {
    prefixKeys(e.version).forEach((key, depth) => {
      if (!matches.has(key)) matches.set(key, []);
      matches.get(key).push(i);
      lastSeen[depth].set(key, i);
    });
  });
  const keys = [
    ...mostRecentKeys(lastSeen[0], MAX_MAJOR_KEYS),
    ...mostRecentKeys(lastSeen[1], MAX_MINOR_KEYS),
  ];

  const bucketStart = new Map();
  for (const key of keys) {
    const positions = matches.get(key);
    for (const spelled of [key, `v${key}`]) {
      if (exact.has(spelled)) positions.push(exact.get(spelled));
    }
    positions.sort((a, b) => a - b);
    const bucket = walkBack(entries, positions, cutoff);
    for (const p of bucket) include.add(p);
    if (exact.has(key)) include.add(exact.get(key));
    bucketStart.set(key, Math.min(...bucket));
  }

  const subset = [...include].sort((a, b) => a - b);
  const indexOf = new Map(subset.map((p, i) => [p, i]));
  const prefixes = {};
  for (const key of [...bucketStart.keys()].sort()) {
    prefixes[key] = indexOf.get(bucketStart.get(key));
  }

  let latest = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isGenericStable(entries[i])) {
      latest = entries[i].version;
      break;
    }
  }

  return {
    count: entries.length,
    latest,
    tail: indexOf.get(tailStart),
    versions: subset.map((p) => {
      const e = entries[p];
      const flags =
        (e.rolling ? FLAG_ROLLING : 0) | (e.prerelease ? FLAG_PRERELEASE : 0);
      return [e.version, e.created_at, flags];
    }),
    prefixes,
  };
}

/** Parse a /data/<tool>.toml file into entries in file order. */
export function parseToolToml(content) {
  const parsed = parse(content);
  return Object.entries(parsed.versions ?? {}).map(([version, data]) => {
    const createdAt =
      data.created_at instanceof Date
        ? data.created_at.getTime()
        : Date.parse(String(data.created_at));
    if (Number.isNaN(createdAt)) {
      throw new Error(`Invalid created_at for ${version}: ${data.created_at}`);
    }
    return {
      version,
      created_at: createdAt,
      rolling: data.rolling === true,
      prerelease: data.prerelease === true,
    };
  });
}

export function isIndexedToolFile(file) {
  return (
    file.endsWith(".toml") &&
    !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
}

/**
 * Build the whole index from a directory of <tool>.toml files.
 *
 * @param {{docsDir: string, now?: number}} options
 */
export function buildVersionsIndex({ docsDir, now = Date.now() }) {
  const tools = {};
  const files = readdirSync(docsDir).filter(isIndexedToolFile).sort();
  for (const file of files) {
    const entries = parseToolToml(readFileSync(join(docsDir, file), "utf8"));
    if (entries.length === 0) continue;
    tools[file.slice(0, -".toml".length)] = buildToolIndex(entries, { now });
  }
  return {
    format: INDEX_FORMAT,
    generated_at: now,
    horizon: HORIZON_MS,
    tools,
  };
}
