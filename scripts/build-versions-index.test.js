#!/usr/bin/env node
import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildToolIndex,
  FLAG_PRERELEASE,
  FLAG_ROLLING,
  fuzzyVersionMatches,
  HORIZON_MS,
  isIndexedToolFile,
  parseToolToml,
  prefixKeys,
} from "./build-versions-index.js";

const DOCS_DIR = fileURLToPath(new URL("../docs", import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-14T00:00:00.000Z");
const FALLBACK = Symbol("fallback");

// mise's predicates, used here as stand-ins for the client's own rules.
const VERSION_REGEX =
  /(^Available versions:|-src|[-\\.]dev|-latest|-stm|[-\\.]rc|-milestone|-alpha|-beta|[-\\.]pre|-next|-test|-nightly|-canary|-experimental|-insider|-edge|snapshot|SNAPSHOT|master|\d(?:alpha|beta|rc)\d*\b)/i;
const PEP440 =
  /[0-9][-_.]?(?:alpha|beta|preview|pre|rc|a|b|c|dev)[-_.]?[0-9]*(?:$|[^a-z0-9])/i;

// Client matchers. The default and PEP 440 variants share mise's
// `fuzzy_version_matches`; aqua and ubi use narrower rules for prefixes.
const MATCHERS = {
  default: {
    matches: fuzzyVersionMatches,
    isPrerelease: (v) => VERSION_REGEX.test(v),
  },
  pep440: {
    matches: fuzzyVersionMatches,
    isPrerelease: (v) => {
      const pub = v.split("+")[0];
      return PEP440.test(pub) || VERSION_REGEX.test(pub);
    },
  },
  aqua: {
    matches: (q, v) => {
      if (q === "latest") return /^\D*[0-9]/.test(v);
      if (!v.startsWith(q)) return false;
      const rest = v.slice(q.length);
      return rest === "" || (/^[-.]/.test(rest) && rest.length > 1);
    },
    isPrerelease: (v) => VERSION_REGEX.test(v),
  },
};

/**
 * How mise resolves `query` against a full version list
 * (`latest_version_for_query_with_selection_options` with the
 * `filter_cached_prereleases` → `filter_by_date` → `fuzzy_match_filter` →
 * `find_match_in_list` pipeline). Entries are `{version, created_at, flags}`.
 */
function resolveFull(list, query, opts) {
  const visible = list.filter(
    (e) =>
      (opts.prereleases || !(e.flags & FLAG_PRERELEASE)) &&
      (opts.before === undefined || e.created_at < opts.before),
  );
  const m = MATCHERS[opts.matcher];
  let matches = visible
    .map((e) => e.version)
    .filter(
      (v) =>
        v === query ||
        (!(!opts.prereleases && m.isPrerelease(v)) && m.matches(query, v)),
    );
  if (matches.length === 0 && query === "latest") {
    matches = visible.map((e) => e.version);
  }
  if (matches.includes(query)) return query;
  return matches.at(-1) ?? null;
}

/**
 * Reference client for docs/versions-index.md: resolve `query` from one tool's
 * index entry, or return FALLBACK when the index cannot prove its answer.
 */
function resolveFromIndex(tool, query, opts) {
  const subset = tool.versions.map(([version, created_at, flags]) => ({
    version,
    created_at,
    flags,
  }));
  if (subset.length === tool.count) return resolveFull(subset, query, opts);

  const m = MATCHERS[opts.matcher];
  const matches = [];
  subset.forEach((e, i) => {
    if (!opts.prereleases && e.flags & FLAG_PRERELEASE) return;
    if (opts.before !== undefined && e.created_at >= opts.before) return;
    const v = e.version;
    if (
      v === query ||
      (!(!opts.prereleases && m.isPrerelease(v)) && m.matches(query, v))
    ) {
      matches.push({ v, i });
    }
  });
  if (matches.some((x) => x.v === query)) return query;

  let from;
  if (query === "latest") from = tool.tail;
  else if (Object.hasOwn(tool.prefixes, query)) {
    from = Math.min(tool.prefixes[query], tool.tail);
  } else return FALLBACK;

  const last = matches.at(-1);
  return last && last.i >= from ? last.v : FALLBACK;
}

function entry(version, daysAgo, flags = 0) {
  return { version, created_at: NOW - daysAgo * DAY, flags };
}

function toBuildInput(list) {
  return list.map((e) => ({
    version: e.version,
    created_at: e.created_at,
    rolling: Boolean(e.flags & FLAG_ROLLING),
    prerelease: Boolean(e.flags & FLAG_PRERELEASE),
  }));
}

const QUERY_OPTIONS = [];
for (const matcher of Object.keys(MATCHERS)) {
  for (const prereleases of [false, true]) {
    for (const ageDays of [undefined, 1, 3, 7, 14, 30]) {
      for (const clientLagDays of [0, 2]) {
        QUERY_OPTIONS.push({
          matcher,
          prereleases,
          before:
            ageDays === undefined
              ? undefined
              : NOW + clientLagDays * DAY - ageDays * DAY,
        });
      }
    }
  }
}

/** Queries worth checking against a list: every key, `latest`, versions. */
function queriesFor(list) {
  const queries = new Set(["latest", "v1", "lts", "nightly"]);
  for (const e of list) {
    for (const key of prefixKeys(e.version)) queries.add(key);
  }
  for (const e of list.slice(-5)) queries.add(e.version);
  if (list.length > 0) queries.add(list[0].version);
  return [...queries];
}

/**
 * Check that the index never contradicts the full list; return hit counts.
 */
function assertAgrees(name, list, tool, queries = queriesFor(list)) {
  let hits = 0;
  let total = 0;
  for (const query of queries) {
    for (const opts of QUERY_OPTIONS) {
      const got = resolveFromIndex(tool, query, opts);
      total++;
      if (got === FALLBACK) continue;
      hits++;
      const want = resolveFull(list, query, opts);
      if (got !== want) {
        assert.fail(
          `${name}: query ${JSON.stringify(query)} ${JSON.stringify(opts)}: index gave ${got}, full list gives ${want}`,
        );
      }
    }
  }
  return { hits, total };
}

describe("fuzzyVersionMatches", () => {
  // The regex matcher mise's `fuzzy_version_matches` replaced; mise's own test
  // asserts the two agree on these inputs.
  function byRegex(query) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern =
      query === "latest"
        ? "v?[0-9].*"
        : /^[0-9]/.test(query)
          ? `v?${esc(query)}`
          : esc(query);
    const numeric = /^[0-9]/.test(query.replace(/^[vV]/, ""));
    const sep = query === "latest" || numeric ? "[+\\-.]" : "[\\-.]";
    const main =
      query !== "latest" && query.endsWith("-")
        ? new RegExp(`^${pattern}.*$`)
        : new RegExp(`^${pattern}(${sep}.+)?$`);
    const withoutV = /^[vV]/.test(query)
      ? query.endsWith("-")
        ? new RegExp(`^${esc(query.slice(1))}.*$`)
        : new RegExp(`^${esc(query.slice(1))}(${sep}.+)?$`)
      : null;
    return (v) => main.test(v) || (withoutV !== null && withoutV.test(v));
  }

  const queries = [
    "latest",
    "1",
    "1.2",
    "1.2.3",
    "10",
    "v1",
    "v1.2",
    "V1.2",
    "vv1",
    "v",
    "V",
    "",
    "temurin",
    "temurin-",
    "temurin-21",
    "v-",
    "1-",
    "lts",
    "lts-iron",
    "truffleruby",
    "truffleruby+graalvm",
    "ref:main",
    "3.14.0a1",
    "1.2.",
    "1.2+",
    "a.b",
    "é",
    "1\n",
  ];
  const versions = [
    "",
    "1",
    "1.2",
    "1.2.3",
    "1.20",
    "1.2-rc1",
    "1.2+build",
    "1.2.",
    "1.2-",
    "1.2+",
    "1.2.\n",
    "1.2.x\ny",
    "v1.2",
    "v1.2.3",
    "V1.2",
    "vv1.2",
    "10",
    "10.0",
    "v10.1",
    "1\n",
    "1\nx",
    "temurin-21.0.1",
    "temurin",
    "temurin21",
    "temurin.1",
    "temurin+x",
    "lts",
    "lts-iron",
    "truffleruby-34.0.1",
    "truffleruby+graalvm-34.0.1",
    "latest",
    "x1.2",
    "v",
    "-",
    "1-rc",
    "1-",
    "v-1",
    "é-1",
    "3.14.0a1",
    "a.b.c",
    "v1\n",
    "1.2+b.4",
  ];

  it("agrees with the regexes mise's matcher replaced", () => {
    for (const query of queries) {
      const re = byRegex(query);
      for (const version of versions) {
        assert.strictEqual(
          fuzzyVersionMatches(query, version),
          re(version),
          `query ${JSON.stringify(query)} version ${JSON.stringify(version)}`,
        );
      }
    }
  });

  it("matches numeric prefixes at separators only", () => {
    assert.ok(fuzzyVersionMatches("1.2", "1.2.3"));
    assert.ok(fuzzyVersionMatches("1.2", "1.2+build"));
    assert.ok(!fuzzyVersionMatches("1.2", "1.20"));
    assert.ok(fuzzyVersionMatches("10", "v10.34.5"));
    assert.ok(!fuzzyVersionMatches("truffleruby", "truffleruby+graalvm-1"));
  });
});

describe("prefixKeys", () => {
  it("cuts at the first two separators of numeric versions", () => {
    assert.deepStrictEqual(prefixKeys("22.11.0"), ["22", "22.11"]);
    assert.deepStrictEqual(prefixKeys("v22.11.0"), ["22", "22.11"]);
    assert.deepStrictEqual(prefixKeys("3.12.0a1"), ["3", "3.12"]);
    assert.deepStrictEqual(prefixKeys("2024-01-15"), ["2024", "2024-01"]);
    assert.deepStrictEqual(prefixKeys("1.2"), ["1"]);
    assert.deepStrictEqual(prefixKeys("1.22rc1"), ["1"]);
    assert.deepStrictEqual(prefixKeys("1.2.3+build"), ["1", "1.2"]);
    assert.deepStrictEqual(prefixKeys("20240115"), []);
    assert.deepStrictEqual(prefixKeys("nightly"), []);
    assert.deepStrictEqual(prefixKeys("V1.2.3"), []);
    assert.deepStrictEqual(prefixKeys("1..2"), ["1"]);
    assert.deepStrictEqual(prefixKeys("1."), []);
  });

  it("produces keys that match their version", () => {
    for (const v of ["22.11.0", "v1.2.3", "2024-01-15", "3.15-dev", "1.2+b"]) {
      for (const key of prefixKeys(v)) {
        assert.ok(fuzzyVersionMatches(key, v), `${key} should match ${v}`);
      }
    }
  });
});

describe("buildToolIndex", () => {
  it("keeps list order and flags, and records the tail", () => {
    const list = [
      entry("1.0.0", 400),
      entry("1.1.0", 300),
      entry("2.0.0", 200),
      entry("2.1.0", 20),
      entry("2.2.0-rc1", 3),
      entry("2.2.0", 1),
      entry("nightly", 0, FLAG_ROLLING),
    ];
    const tool = buildToolIndex(toBuildInput(list), { now: NOW });
    assert.strictEqual(tool.count, 7);
    assert.strictEqual(tool.latest, "2.2.0");
    // The tail runs back to 2.1.0, the first stable entry past the horizon.
    const tailVersions = tool.versions.slice(tool.tail).map((e) => e[0]);
    assert.deepStrictEqual(tailVersions, [
      "2.1.0",
      "2.2.0-rc1",
      "2.2.0",
      "nightly",
    ]);
    assert.deepStrictEqual(tool.versions.at(-1), [
      "nightly",
      NOW,
      FLAG_ROLLING,
    ]);
    // Older prefixes keep their newest stable entry; every minor here is one.
    assert.deepStrictEqual(
      tool.versions.map((e) => e[0]),
      ["1.0.0", "1.1.0", "2.0.0", "2.1.0", "2.2.0-rc1", "2.2.0", "nightly"],
    );
    assert.strictEqual(tool.versions[tool.prefixes["1"]][0], "1.1.0");
    assert.strictEqual(tool.versions[tool.prefixes["1.0"]][0], "1.0.0");
  });

  it("never ranks versions itself", () => {
    // A list in an order no version sort would produce.
    const list = [
      entry("3.0.0", 100),
      entry("1.0.0", 90),
      entry("10.0.0", 80),
      entry("2.0.0", 70),
    ];
    const tool = buildToolIndex(toBuildInput(list), { now: NOW });
    assert.strictEqual(tool.latest, "2.0.0");
    assert.deepStrictEqual(
      tool.versions.map((e) => e[0]),
      ["3.0.0", "1.0.0", "10.0.0", "2.0.0"],
    );
  });

  it("includes a version spelled like a key", () => {
    const list = [entry("22", 900)];
    for (let i = 0; i < 40; i++) list.push(entry(`22.${i}.0`, 40 - i));
    list.push(entry("latest", 800));
    for (let i = 0; i < 40; i++) list.push(entry(`23.${i}.0`, 0.5));
    const tool = buildToolIndex(toBuildInput(list), { now: NOW });
    const versions = tool.versions.map((e) => e[0]);
    assert.ok(versions.includes("22"));
    assert.ok(versions.includes("latest"));
    assertAgrees("spelled-like-key", list, tool);
  });

  it("counts a v-spelled key among the key's matches", () => {
    const list = [];
    for (let i = 0; i < 10; i++) list.push(entry(`22.${i}.0`, 300 - i));
    list.push(entry("v22", 100));
    for (let i = 0; i < 10; i++) list.push(entry(`23.${i}.0`, 50 - i));
    const tool = buildToolIndex(toBuildInput(list), { now: NOW });
    const opts = { matcher: "default", prereleases: false };
    assert.strictEqual(resolveFull(list, "22", opts), "v22");
    assert.strictEqual(resolveFromIndex(tool, "22", opts), "v22");
    assertAgrees("v-spelled", list, tool);
  });

  it("caps runs and falls back past them", () => {
    const list = [entry("1.0.0", 500)];
    for (let i = 0; i < 100; i++) list.push(entry(`2.0.${i}-rc`, 0.1));
    const tool = buildToolIndex(toBuildInput(list), { now: NOW });
    assert.ok(tool.versions.length <= 64);
    const opts = { matcher: "default", prereleases: false, before: NOW - DAY };
    assert.strictEqual(resolveFromIndex(tool, "latest", opts), FALLBACK);
    assert.strictEqual(resolveFull(list, "latest", opts), "1.0.0");
    assertAgrees("capped", list, tool);
  });

  it("answers the default 24h cutoff from the tail", () => {
    const list = [];
    for (let i = 0; i < 50; i++) list.push(entry(`1.${i}.0`, 50 - i));
    const tool = buildToolIndex(toBuildInput(list), { now: NOW });
    const opts = { matcher: "default", prereleases: false, before: NOW - DAY };
    assert.strictEqual(resolveFromIndex(tool, "latest", opts), "1.48.0");
    assert.strictEqual(resolveFromIndex(tool, "1", opts), "1.48.0");
    assert.strictEqual(
      resolveFromIndex(tool, "1.48", { ...opts, before: undefined }),
      "1.48.0",
    );
  });

  it("agrees with full-list resolution on varied version schemes", () => {
    const schemes = {
      semver: (i) => `${Math.floor(i / 30)}.${Math.floor(i / 5) % 6}.${i % 5}`,
      vprefixed: (i) => `v${Math.floor(i / 20)}.${i % 20}.0`,
      dates: (i) => `${2020 + Math.floor(i / 12)}.${(i % 12) + 1}.15`,
      dashed: (i) => `${2020 + Math.floor(i / 12)}-${(i % 12) + 1}-01`,
      pep440: (i) =>
        i % 4 === 3 ? `3.${i >> 3}.0a${i % 3}` : `3.${i >> 3}.${i % 4}`,
      rcs: (i) => (i % 3 === 0 ? `1.${i}.0-rc.1` : `1.${i - (i % 3)}.${i % 3}`),
    };
    for (const [name, make] of Object.entries(schemes)) {
      const list = [];
      for (let i = 0; i < 120; i++) {
        const flags = i % 17 === 0 ? FLAG_PRERELEASE : 0;
        list.push(entry(make(i), (120 - i) * 0.6, flags));
      }
      list.push(entry("nightly", 0, FLAG_ROLLING));
      const tool = buildToolIndex(toBuildInput(list), { now: NOW });
      const { hits } = assertAgrees(name, list, tool);
      assert.ok(hits > 0, `${name}: expected some answers from the index`);
    }
  });
});

describe("versions index over docs/", { skip: !existsSync(DOCS_DIR) }, () => {
  it("never contradicts the full per-tool lists", () => {
    const files = readdirSync(DOCS_DIR).filter(isIndexedToolFile).sort();
    let hits = 0;
    let total = 0;
    for (const file of files) {
      const parsed = parseToolToml(readFileSync(join(DOCS_DIR, file), "utf8"));
      if (parsed.length === 0) continue;
      const list = parsed.map((e) => ({
        version: e.version,
        created_at: e.created_at,
        flags:
          (e.rolling ? FLAG_ROLLING : 0) | (e.prerelease ? FLAG_PRERELEASE : 0),
      }));
      const tool = buildToolIndex(parsed, { now: NOW });
      // Every key the index publishes, plus `latest`.
      const queries = ["latest", ...Object.keys(tool.prefixes)];
      const r = assertAgrees(file, list, tool, queries);
      hits += r.hits;
      total += r.total;
    }
    assert.ok(total > 0);
    assert.ok(hits / total > 0.5, `hit rate ${hits}/${total}`);
  });
});

it("HORIZON_MS covers mise's default 24h minimum_release_age", () => {
  assert.ok(HORIZON_MS >= 7 * DAY);
});
