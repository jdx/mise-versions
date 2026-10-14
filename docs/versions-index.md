# Versions index (format 1)

The versions index is one static JSON file that lets a mise client resolve
`latest` and the common fuzzy prefixes (`22`, `3.12`, `2026`) for every tool
with a single request, instead of downloading `data/<tool>.toml` once per tool.
`mise outdated`, `mise upgrade`, `mise latest` and cold installs are the
intended users.

This document is the client contract. The generator is
[`scripts/build-versions-index.js`](../scripts/build-versions-index.js), and a
reference client lives in
[`scripts/build-versions-index.test.js`](../scripts/build-versions-index.test.js)
(`resolveFromIndex`), tested against full-list resolution (`resolveFull`) over
every tool in `docs/`.

## Design in one paragraph

For each tool the index stores an **order-preserving subset** of the entries in
`data/<tool>.toml`, plus **coverage markers** saying which parts of the full
list the subset contains in full. The server never sorts, ranks or filters by
pre-release status; it only chooses which entries to copy. The client runs its
own matching, pre-release and `minimum_release_age` rules over the subset,
exactly as it would over the full list, and the coverage markers tell it whether
the answer is guaranteed to be the same as the full list would give. If not, it
falls back to `data/<tool>.toml`. So correctness never depends on the server
mirroring a backend's rules; those rules only affect how often the client has to
fall back.

## URL and delivery

```
https://mise-versions.jdx.dev/data/index.v1.json
```

- A static asset served by Cloudflare, like `data/<tool>.toml`. No Worker code
  runs on this path.
- `Content-Type: application/json`. Cloudflare compresses according to
  `Accept-Encoding` (zstd, brotli or gzip). mise's HTTP client already sends
  `gzip, zstd`.
- `Cache-Control: public, max-age=0, must-revalidate` with an `ETag`, the same
  as the per-tool files. Clients should keep their own copy for the same time as
  a remote version list (`fetch_remote_versions_cache`, default 1h) and may
  revalidate with `If-None-Match`.
- A 404 (for example, before the first deploy that publishes the index) falls
  through to the Worker. Clients should remember a failed fetch for the rest of
  the process and fall back to per-tool files, as they do today.

Size with the data on 2026-10-14 (1,057 tools):

| encoding | bytes |
| -------- | ----: |
| raw      | 504 KB |
| gzip -9  | 135 KB |
| zstd -3  | 138 KB |
| brotli   |  97 KB |

That is one request regardless of how many tools a project uses. For
comparison, `data/node.toml` alone is 46 KB raw and 5 KB gzipped, and a cold
`mise outdated` for 8 tools fetches about 40 KB gzipped over 9 requests.
Sharding is not needed at this size. If the file ever grows past about 500 KB
compressed, the plan is to split it by the first character of the tool name
into `index.v1/<c>.json`, which keeps "one request per resolved tool group"
without changing the per-tool schema.

## Freshness

`scripts/build-static-version-files.js` writes the index and every
`data/<tool>.toml` from the same `docs/` checkout during the web build. A single
`wrangler deploy` then publishes them together, so the index is never staler
than the per-tool files. The deploy runs on every push to `docs/*.toml`, and the
update workflow pushes every 15 minutes. `generated_at` records when the index
was built.

## Schema

```json
{
  "format": 1,
  "generated_at": 1792008000000,
  "horizon": 1209600000,
  "tools": {
    "go": {
      "count": 291,
      "latest": "1.27.2",
      "tail": 9,
      "versions": [
        ["1.20", 1675278226000, 0],
        ["1.20.14", 1707243748000, 0],
        ["1.21.13", 1722965948000, 0],
        ["1.22.12", 1738687189000, 0],
        ["1.23.12", 1754503738000, 0],
        ["1.24.13", 1770220008000, 0],
        ["1.25.14", 1787150636000, 0],
        ["1.26.8", 1788292579000, 0],
        ["1.26.9", 1791473776000, 0],
        ["1.27.1", 1788292373000, 0],
        ["1.27.2", 1791473770000, 0]
      ],
      "prefixes": {
        "1": 9,
        "1.20": 1,
        "1.21": 2,
        "1.22": 3,
        "1.23": 4,
        "1.24": 5,
        "1.25": 6,
        "1.26": 7,
        "1.27": 9
      }
    }
  }
}
```

### Top level

| field          | type    | meaning |
| -------------- | ------- | ------- |
| `format`       | integer | Format version, `1` for this document. A client must not use the file unless it knows this exact value. |
| `generated_at` | integer | Build time, Unix epoch milliseconds (UTC). |
| `horizon`      | integer | Informational. The release age (ms) the build aimed to cover; see [Coverage heuristics](#coverage-heuristics). |
| `tools`        | object  | Tool name → tool entry. Names are the same as in `data/<tool>.toml`. |

A tool is absent when `docs/<tool>.toml` does not exist or is empty. The
`python-precompiled*` files are not tool version lists and are never indexed.

### Tool entry

Let **L** be the tool's full list: the `[versions]` table of
`data/<tool>.toml` in file order, published from the same build. Let **S** be
`versions`.

| field      | type                    | meaning |
| ---------- | ----------------------- | ------- |
| `count`    | integer                 | Number of entries in L. |
| `latest`   | string or null          | Informational: the last entry in L that every mise backend would call stable (see below), with no release-age cutoff. Null when there is none. Clients that resolve with the algorithm below do not need it. |
| `versions` | array of entries        | S, a subsequence of L in L's order. Never empty. |
| `tail`     | integer                 | An index into S (see guarantee G1). |
| `prefixes` | object: string → integer | Prefix key → index into S (see G2, G3). May be empty. |

Each entry is a three-element array `[version, created_at, flags]`:

| element      | type    | meaning |
| ------------ | ------- | ------- |
| `version`    | string  | The version string exactly as it appears in `data/<tool>.toml`. |
| `created_at` | integer | The entry's `created_at`, in Unix epoch milliseconds. Every timestamp in the per-tool files has millisecond precision, so this is exact. |
| `flags`      | integer | Bit field. `1` = `rolling = true`; `2` = `prerelease = true`. Other bits are reserved and must be ignored. |

Map an entry to mise's `VersionInfo` as the per-tool file does today:
`created_at` becomes an RFC 3339 string; `rolling` is `flags & 1 != 0`;
`prerelease` is `Some(true)` when `flags & 2 != 0`, otherwise `None`
(the per-tool files only ever record `prerelease = true`, so "absent" means
unknown, as before). `release_url` is not included; a client that needs it reads
`data/<tool>.toml`.

"Stable" for `latest` means: the version starts with a digit after an optional
lowercase `v`; it is not rolling; it is not flagged as a pre-release; and it
matches neither mise's shared `VERSION_REGEX` nor `PEP440_PRERELEASE_REGEX` (on
the part before any `+`).

## Ordering guarantee

S is a subsequence of L in L's order. L's order is the order `mise ls-remote`
printed. That order is mise's per-backend sort, plus the existing per-tool
post-processing in `scripts/update.sh`, such as `sort -V` for java and the
HashiCorp tools, and semver sorting for `scripts/unstable-tools.txt`. It is the
order a client gets from `data/<tool>.toml` today. The index never reorders
anything. "Newest" always means "later in L", which is what mise's resolution
already assumes when it takes the last match.

## Coverage guarantees

These are the only things a client may rely on. Positions refer to L.

- **G1 (tail).** `S[tail..]` is a contiguous suffix of L: it is exactly the last
  `len(S) - tail` entries of L, in order.
- **G2 (prefix buckets).** For each `prefixes[P] = k`: `S[k]` is an entry for
  which `fuzzy_version_matches(P, version)` is true. Every entry of L at or after
  `S[k]` for which `fuzzy_version_matches(P, version)` is true is in S.
  `fuzzy_version_matches` is the function in jdx/mise `src/backend/mod.rs`; the
  generator mirrors it in `fuzzyVersionMatches` and tests the mirror against the
  regex oracle from mise's own test.
- **G3 (exact spellings).** For each key P in `prefixes`, if L has an entry whose
  version is exactly P, that entry is in S. If L has an entry whose version is
  exactly `latest`, it is in S.
- **G4 (complete lists).** If `count == len(S)`, then S is L.

Keys are derived from the versions themselves, never from semver. Take a version
in L that starts with a digit after an optional lowercase `v`. Its keys are the
text before its first and before its second separator (`+`, `-` or `.`), where
at least one character follows the separator. `v22.11.0` gives `22` and `22.11`.
`2024-01-15` gives `2024` and `2024-01`. `3.12.0a1` gives `3` and `3.12`.
`1.22rc1` gives only `1`, matching mise, where `1.22` does not select `1.22rc1`.
`20240115` and `nightly` give none. Clients never need to derive keys; they look
up the query string as given.

## Client algorithm

Preconditions for using the index for a tool (otherwise fall back):

1. The client would otherwise resolve this tool from `data/<tool>.toml`, which
   means `use_versions_host` is on and the tool is served by the versions host.
2. The request uses source order (`version_order` is the default). A
   non-default `version_order` reorders matches, so the subset argument below no
   longer holds.
3. The client's version filters are **per entry**. Today these are the
   pre-release flag filter (`filter_cached_prereleases`), pattern pre-release
   marking (`mark_prerelease`), the release-date cutoff (`filter_by_date`) and
   the backend's pre-release predicate. All of them qualify.
4. For a prefix query, the backend's matcher selects a **subset** of what
   `fuzzy_version_matches` selects for the same query, apart from the exact
   `version == query` bypass. The default matcher, the PEP 440 variant
   (`fuzzy_match_versions_pep440`) and aqua's and ubi's matchers for non-`latest`
   queries all qualify. `latest` uses only G1, so any matcher is fine there.

To resolve query `q` for tool `t` with the client's normal filters:

1. Let `e = index.tools[t]`. If it is absent, fall back.
2. Build the candidate list from `e.versions` in order, keeping each entry's
   index `i` in S. Apply the same per-entry filters the client applies to the
   full list (pre-release flag, release-date cutoff, and so on).
3. If `e.count == len(e.versions)` (G4), run the client's normal resolution
   on the filtered list. Its result is final, including "no match".
4. Run the client's matcher over the filtered list, `fuzzy_match_filter(versions,
   q, …)`, to get `matches` in order.
5. If `q` itself is in `matches`, the answer is `q` (`find_match_in_list`).
6. Find the coverage start `c`:
   - `q == "latest"`: `c = e.tail`.
   - `q` is a key of `e.prefixes`: `c = min(e.prefixes[q], e.tail)`.
   - otherwise: fall back.
7. Let `m` be the last element of `matches`. If `m` exists and its index
   `i >= c`, the answer is `m`. Otherwise fall back.

That is the whole algorithm. Step 7 only accepts an answer when every full-list
entry after it that could match is guaranteed to be in S. Those entries were
seen in step 4 and rejected by the same filters, so the full list's last match
is `m`. Step 5 is safe because a listed version that equals the query always
wins in mise. G3 is what makes a key query safe against the case of an older,
exactly-spelled entry that isn't in S.

Fall back to `data/<tool>.toml` when:

- the index is missing, unreadable, or its `format` is not `1`;
- the algorithm above says so (the tool is absent, the query is not a key, or
  the answer would be older than the coverage start). This includes "no
  matching version" for a partial list. mise reports which versions the
  release-age cutoff hid in that case, and that message needs the full list.
- the command needs the whole list (`mise ls-remote`, completions, lockfile
  work that needs `release_url`).

Never store the index subset as the tool's remote version list in the client's
cache. It is not the full list.

### Worked examples (index above, generated 2026-10-14)

- `go@latest`, default 24h cutoff, `prereleases` off: the last match at or after
  `tail = 9` is `1.27.2` (created 2026-10-08), so the answer is `1.27.2`.
- `go@1.26`, 30-day cutoff (before 2026-09-14): `1.26.9` is hidden. The next
  match is `1.26.8` at index 7, and `prefixes["1.26"] = 7`, so the answer is
  `1.26.8`.
- `go@1.19`: `1.19` is not a key, so the client falls back to `data/go.toml`.
- `node@20`, any cutoff under the horizon: `prefixes["20"]` points at
  `20.20.2`, so the answer is `20.20.2`.

## Coverage heuristics

Informative. These choose which entries go into S. They are tuned for size and
hit rate and may change without a format bump, because the client only relies
on G1–G4.

- **Runs.** The tail and each prefix bucket are built by walking L (or the
  key's matches) backwards from the end. A walk stops after the first entry
  that is stable (as defined for `latest`) and older than
  `generated_at - horizon`, or after 32 entries. The horizon is 14 days, so a
  client with `minimum_release_age` up to 14 days (mise's default is 24h)
  normally gets its answer from the index.
- **Why adaptive, and why 32.** Release cadence was measured over a year of
  weekly snapshots of all 1,057 tools. For a 7-day cutoff, a fixed tail of N
  entries reaches the answer in 94.8% of snapshots at N=5, 97.4% at N=10 and
  98.6% at N=20. The 99th percentile is 27 entries, and a handful of tools
  need 300 or more. A fixed N=27 would cost 1,057 × 27 ≈ 28,500 entries. The
  adaptive tail reaches the first settled stable release for every tool that
  has one, using 2,652 entries in total, which is 1 for most tools. The 32-entry
  cap covers that 99th percentile. The remainder are tools that publish only
  pre-releases or non-numeric versions (amp, mc), and those fall back.
- **Keys.** For each tool, the 16 first-component keys and the 8 second-component
  keys whose newest entry appears latest in L. Old majors cost one entry each.
  Keeping every minor of every tool would triple the file, because many tools
  ship one release per minor.

Hit rates on 2026-10-14 data, with the default matcher and pre-releases off,
are below. Correctness was checked separately against full-list resolution.

| query                        | no cutoff | 24h   | 7d    | 30d   |
| ---------------------------- | --------: | ----: | ----: | ----: |
| `latest`                     | 99.0%     | 99.0% | 98.8% | 62.4% |
| newest major (e.g. `26`)     | 97.0%     | 97.0% | 96.6% | 61.1% |
| second newest major          | 96.4%     | 96.4% | 96.4% | 90.5% |
| newest minor (e.g. `26.11`)  | 92.5%     | 92.5% | 86.7% | 53.9% |
| third newest minor           | 98.9%     | 98.9% | 98.5% | 88.6% |

The misses for "newest minor" are almost all minors that so far contain only
pre-releases (`2.42.0-beta.01`, `3.6.0-rc2`). mise finds no stable match there
either, so falling back is the right outcome. Cutoffs beyond the 14-day horizon
fall back more often by design.

## Versioning

- The format number is in both the file name and the `format` field.
- Within format 1, the server may add top-level or per-tool fields and may set
  new `flags` bits. Clients must ignore what they don't know. Entry arrays keep
  their first three elements; any added elements come after them.
- Anything that changes the meaning of an existing field or guarantee gets a new
  format. The server then publishes `index.v2.json` alongside `index.v1.json`,
  and keeps v1 until the mise releases that read it are out of support.
- Tuning the heuristics (horizon, caps, key budgets) is not a format change.
