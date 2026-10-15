# GitHub versions listing (format 1)

One request returns a public GitHub repository's whole release list, or its
whole tag list, in compact form. It replaces paging through
`api.github.com/repos/{owner}/{repo}/releases` or `/tags` (or the mirror's
`/api/github/.../releases?page=N` and `/tags?page=N`) when mise lists the
versions of a `github:`, `aqua:` or `packslip:` tool.

This document is the client contract. The server is in
[`web/src/lib/github/versions.ts`](../web/src/lib/github/versions.ts), the
Worker route in
[`web/src/pages/data/github/`](../web/src/pages/data/github/[owner]/[repo]/[...file].ts)
and the deploy-time bake in
[`scripts/bake-github-versions.js`](../scripts/bake-github-versions.js).

## Request

```
GET https://mise-versions.jdx.dev/data/github/{owner}/{repo}/releases.json
GET https://mise-versions.jdx.dev/data/github/{owner}/{repo}/tags.json
GET https://mise-versions.jdx.dev/data/github/{owner}/{repo}/assets/{asset}/releases.json
```

- `owner` and `repo` **must be lowercase**. GitHub treats them
  case-insensitively, and the files are baked in lowercase. A path that is not
  lowercase gets a 404. They match `[a-z0-9_.-]+`, and `.` and `..` are
  rejected.
- `releases.json` lists GitHub releases. `tags.json` lists git tags.
- `assets/{asset}/releases.json` lists only the releases that carry an asset
  with exactly this name, for example `packslip.sigstore.json`. The asset keeps
  its case and matches `[A-Za-z0-9._+@~-]{1,255}`.
- The query string is ignored.

The client does not need to know how a response was produced, and cannot tell
from the body. The same URL is either a static file baked at deploy time, or
the Worker's answer for a list that has not been baked yet.

## Response

`200`, `Content-Type: application/json`. Cloudflare compresses according to
`Accept-Encoding`.

### `releases.json`

```json
{
  "source": "releases",
  "fetched_at": "2026-10-14T21:20:41Z",
  "releases": [
    {
      "tag": "v2.102.0",
      "date": "2026-09-30T02:40:02Z",
      "prerelease": false,
      "asset_count": 22
    }
  ],
  "truncated": false
}
```

| field | meaning |
| --- | --- |
| `fetched_at` | When page 1 of the list was last read from GitHub (RFC 3339, UTC). See [Freshness](#freshness). |
| `tag` | The release's `tag_name`. |
| `date` | `published_at`, or `created_at` when GitHub has no `published_at`. This is mise's `GithubRelease::released_at()`. |
| `prerelease` | GitHub's `prerelease` flag. |
| `asset_count` | How many assets the release has. `0` is a release mise's github backend drops (`github_release_has_assets`) unless the tool has a direct `url`. |

Drafts are never included.

### `tags.json`

```json
{
  "source": "tags",
  "fetched_at": "2026-10-14T21:20:43Z",
  "tags": [
    {
      "tag": "11.0.27",
      "sha": "52f3b364e5882a5dbcfc42cb8313a7c2ae532c64",
      "date": "2026-10-06T18:22:36Z"
    }
  ],
  "truncated": false
}
```

| field | meaning |
| --- | --- |
| `tag` | The tag name. |
| `sha` | The commit the tag points to (peeled, as in GitHub's REST tag list). |
| `date` | The commit's committer date (`commit.committer.date`, what `list_tags_with_dates` reads today), or `null` if GitHub does not know the commit. |

### Ordering

Entries come in **GitHub's REST order** for that list, newest first, exactly
as paging through the REST endpoint would give them. Releases follow GitHub's
release order, which is **not** sorted by `date`: 156 neighbouring pairs of
openai/codex's 1,226 releases are out of creation order. Tags are sorted by
name, highest version first. Clients that today use the REST order (for
example the github backend, which reverses it) can use this order unchanged.
Do not re-sort by `date`.

### Truncation

`truncated: false` means the list is complete.

`truncated: true` means the list is a **newest-first prefix**: every entry
present is in its correct place, and older entries exist that are not listed.
This happens when:

- the repository has more than 20 pages (2,000 entries), or
- GitHub could not serve all pages within the server's 20-second crawl budget.
  So far this only happens for openai/codex, where each REST page is about 32 MB
  and takes GitHub around 8 s, so the server keeps 100–200 releases. It can also
  happen if GitHub fails part-way through a crawl, or a page is still open at
  the crawl's 25-second deadline, or
- nobody had asked for the list before, and reading it takes more than about
  1.5 s (lists of a few hundred entries or more). The first request is then
  answered with the newest entries already read (100, or 20 if page 1 is still
  loading), while the whole list is read and stored in the background. Requests
  after that, from a minute later at the same location, get the whole list.
  mise's prefer-offline commands give a lookup a single 3 s attempt, which a
  full crawl of a big repository can exceed, or
- the list kept changing while it was read. Pages are read at slightly
  different moments, so a release published or deleted mid-crawl could
  otherwise drop an entry at a page boundary. The server reads the exact number
  of entries and the newest one before and after a crawl, and crawls once more
  if either changed. If the list is still moving, the server keeps only the
  newest 20 entries, truncated, and crawls in full at the next refresh.

What a client should do with a truncated list:

- **Resolving `latest` or a prefix such as `1.2`** can use the prefix whenever it
  contains a matching stable entry. This is the same rule
  `has_stopping_stable_release` uses to stop paging today.
- **Listing every version** (`MISE_LIST_ALL_VERSIONS`, `mise ls-remote --all`)
  needs the rest from GitHub.

## Freshness

**A list can lag GitHub.** The lag is bounded by how often it is refreshed
(below) plus up to one deploy interval: a baked file changes only when the next
deploy publishes it. Deploys run every time the version catalog changes,
typically every 15–30 minutes. `fetched_at` says how old a response is, so a
client can decide when that matters.

How often each list is refreshed:

| | when |
| --- | --- |
| **Page 1** (new releases and tags) | After a quarter of the time the list has been unchanged, between **10 minutes and 6 hours**. A repo that just released is refreshed on every deploy; a repo quiet for a day or more, about every 6 hours. Releases read the newest 20 entries (new releases land there); tags read all of page 1, because a new tag on an older line can sort anywhere on it. |
| **A new release in a tracked repo** | For a repo the mise-versions catalog tracks, a newly published release rotates the repo's release generation (the same signal that refreshes `/releases/latest`). The next deploy then refreshes page 1, whatever the backoff. The catalog syncs every 15 minutes, and a catalog change itself triggers the deploy. |
| **Everything else** (edits and deletions past page 1, a tag on an older release line) | A full re-crawl every **6 hours**. |

In practice:

- A new release of a tracked repo appears within about one deploy of the
  catalog seeing it.
- A new release of an untracked repo that was quiet appears within about 6 hours
  plus one deploy. An active repo's appears within one deploy.
- An exact version (`mise install github:o/r@1.2.3`) does not need the list.
  If a client finds a version missing from a list whose `fetched_at` is older
  than it can accept, it can ask GitHub (or the mirror's `/releases/{tag}`)
  for that one release.

Caching headers:

- Baked files carry `Cache-Control: public, max-age=0, must-revalidate` and an
  `ETag`, like `data/<tool>.toml`.
- The Worker's answers carry `Cache-Control: public, max-age=0, s-maxage=N`
  with N at most 600.
- Clients keep their own copy for as long as any remote version list
  (`fetch_remote_versions_cache`, default 1 h).

## Errors

| status | meaning | client action |
| --- | --- | --- |
| `404` | Not a valid path (including uppercase), or the repo is private, missing or blocked. | Use GitHub quietly, as for releases. |
| `403` | The mirror is disabled or restricted (`GITHUB_MIRROR_ACCESS`). | Warn and use GitHub, as for releases. |
| `429` | This client started too many uncached crawls. | Use GitHub for this tool. |
| `502` | GitHub failed and there was nothing stored to serve. | Use GitHub. |
| `503` | The repo's visibility could not be checked. | Use GitHub. |

A `200` is always a complete or truncated list as described above, never a
partial error.

## Access

Only repositories GitHub reports as public are served, the same as the other
mirror routes. `GITHUB_MIRROR_ACCESS=registry` limits the mirror to repos in the
mise registry, and `off` disables it.

The Worker checks access before answering from any cache. Baked files are
served without the Worker, so every deploy checks each repo again before baking
it. A repo that turns private stops being baked at the next deploy, and is gone
within one deploy plus the 1-hour visibility cache.

## How lists get baked

1. **The first request** for a list misses the static assets and falls
   through to the Worker. The Worker crawls up to 20 pages from GitHub with a
   mirror pool token (repos get the usual visibility and access checks, and a
   per-client limit on cold crawls). It stores the compact list in KV, marks it
   as requested, and answers.
2. **Every deploy** (`deploy.yml`) runs `scripts/bake-github-versions.js`,
   which pages through the stored lists via `/api/admin/github/versions/bake`:
   - lists that are due (see [Freshness](#freshness)) are refreshed first, for
     up to 3 minutes per deploy and only with pool tokens, never anonymously;
   - each repo is checked again for access;
   - the lists are written to `web/dist/client/data/github/` and deploy as
     static assets.

   A failure or timeout bakes what it has and never fails the deploy. Anything
   not baked is still answered by the Worker.
3. **Requests for baked files** never reach the Worker. The nightly Logpush
   rollup (`maintenance.yml`) reports which files mise clients fetched to
   `/api/admin/github/versions/demand`, which keeps them marked as requested.
4. **A list nobody has requested for 30 days** is no longer baked or
   refreshed, and its KV entry expires 30 days after its last write.

### File count

Workers Paid allows 100,000 static asset files per version. The build emits
about 1,100 other files (2026-10-14). The bake caps itself at 95,000 files in
total and keeps the most recently requested lists. Each list is one file.

Realistic demand: about 1,800 distinct GitHub-backed backends have ever
reported an install (aqua 861, github 713, ubi 241 in the analytics
`backends` table), so on the order of 2,000–4,000 files. That is 25–50 times
under the limit, so no sharding is needed.

## Which client uses what

| caller (jdx/mise) | request |
| --- | --- |
| github backend `_list_remote_versions` (`list_releases_including_prereleases_from_url` on github.com) | `releases.json`. Drop `asset_count == 0` unless the tool has a direct `url`. |
| aqua, release-based packages (`get_tags_with_release_dates`) | `releases.json`. `package_has_asset` reads the aqua registry, not release assets. |
| aqua `version_source: github_tag`, ubi tags (`list_tags`, `list_tags_from_url` on github.com) | `tags.json` |
| go with `MISE_LIST_ALL_VERSIONS` (`list_tags_with_dates`) | `tags.json` |
| packslip `vendor_versions` | `assets/<bundle_name(project)>/releases.json` |

The github backend's `security_info` reads asset names of the newest stable
release. It should use `/api/github/repos/{owner}/{repo}/releases/latest` (or
`/releases/{tag}`), not this listing.

## Cost and size

Measured 2026-10-14 by running the server code locally against GitHub with one
pool token. A cold crawl happens once per list; after that, refreshes read page
1 only, and a full crawl runs at most every 6 hours.

| repo | list | entries | truncated | cold crawl | GitHub requests (REST + GraphQL) | raw | gzip | brotli |
| --- | --- | ---: | --- | ---: | --- | ---: | ---: | ---: |
| jqlang/jq | releases | 16 | no | 0.7 s | 1 | 1.4 KB | 0.3 KB | 0.3 KB |
| BurntSushi/ripgrep | releases | 75 | no | 0.7 s | 1 | 6.0 KB | 1.0 KB | 0.7 KB |
| cli/cli | releases | 205 | no | 2.9 s | 3 | 16.8 KB | 2.4 KB | 1.6 KB |
| kubernetes/kubernetes | releases | 821 | no | 1.8 s | 9 | 68.0 KB | 8.8 KB | 6.5 KB |
| zed-industries/zed | releases | 1,311 | no | 4.1 s | 14 | 109.6 KB | 13.5 KB | 9.1 KB |
| openai/codex | releases | 100–200 | yes | ~20 s | 2–3 | 19 KB | 2.3 KB | 1.6 KB |
| apache/tomcat | tags | 540 | no | 1.9 s | 6 + 6 | 51.0 KB | 18.8 KB | 15.4 KB |
| golang/go | tags | 498 | no | 1.7 s | 5 + 5 | 48.7 KB | 17.1 KB | 14.2 KB |

- A page-1 refresh is 1 request (plus 1 GraphQL point for tags) and takes
  0.4–2 s.
- A quiet list costs about 4 full crawls a day (each also reads page 1). An
  active list also costs one page-1 refresh per deploy.
- The pool had 1,330 available tokens on 2026-10-14. Tokens are benched once
  they fall to 4,000 remaining (`src/token-budget.ts`), which leaves about
  1.3 million requests an hour, far more than baking needs.
