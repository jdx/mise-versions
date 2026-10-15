# GitHub versions listing (format 1)

One request returns a public GitHub repository's whole release list, or its
whole tag list, in compact form. It replaces paging through
`api.github.com/repos/{owner}/{repo}/releases` or `/tags` (or the mirror's
`/api/github/.../releases?page=N` and `/tags?page=N`) when mise lists the
versions of a `github:`, `aqua:` or `packslip:` tool.

Clients use the mirror first. mise asks `api.github.com` for these lists
only when the mirror errors (a timeout, a lost connection, `429` or `5xx`),
never on a `404` or an empty answer (see [Errors](#errors)).

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
  gets what the mirror has: a truncated list is the most the mirror holds for
  that repository. The client lists it and says it may be incomplete. For one
  specific older version, it asks the mirror for that version (see
  [one missing version](#one-missing-version)). It does not fall back to
  `api.github.com`.

## Freshness

**A list can lag GitHub.** A refresher runs every 10 minutes and refreshes the
lists that are due (below). When it changes a list, it dispatches a deploy,
which publishes the change in a minute or two. So the lag is about how often
the list is refreshed, plus up to 10 minutes for the refresher's next run, plus
one deploy. `fetched_at` says how old a response is, so a client can decide
when that matters.

How often each list is refreshed:

| | when |
| --- | --- |
| **Page 1** (new releases and tags) | After a quarter of the time the list has been unchanged, between **10 minutes and 6 hours**. A repo that just released is refreshed on every refresher run; a repo quiet for a day or more, about every 6 hours. Releases read the newest 20 entries (new releases land there); tags read all of page 1, because a new tag on an older line can sort anywhere on it. The read is conditional on GitHub's ETag, so an unchanged page costs nothing. |
| **A new release in a tracked repo** | For a repo the mise-versions catalog tracks, a newly published release rotates the repo's release generation (the same signal that refreshes `/releases/latest`). The refresher's next run then refreshes page 1, whatever the backoff. The catalog syncs every 15 minutes. |
| **Everything else** (edits and deletions past page 1, a tag on an older release line) | A full re-crawl every **6 hours**. |

In practice:

- A new release of a tracked repo appears within about 10 minutes plus one
  deploy of the catalog seeing it.
- A new release of an untracked repo that was quiet appears within about 6 hours
  plus 10 minutes and one deploy. An active repo's appears within about 10
  minutes plus one deploy.
- An exact version (`mise install github:o/r@1.2.3`) does not need the list.
  If a client finds a version missing from a list whose `fetched_at` is older
  than it can accept, it asks the mirror for that one version ([one missing version](#one-missing-version)), never
  `api.github.com`.

Caching headers:

- Baked files carry `Cache-Control: public, max-age=0, must-revalidate` and an
  `ETag`, like `data/<tool>.toml`.
- The Worker's answers carry `Cache-Control: public, max-age=0, s-maxage=N`
  with N at most 600.
- Clients keep their own copy for as long as any remote version list
  (`fetch_remote_versions_cache`, default 1 h).

### One missing version

- **From `releases.json`** (or `assets/{asset}/releases.json`): ask the
  mirror's `/api/github/repos/{owner}/{repo}/releases/{tag}`. A 404 there means
  the mirror has no release it can serve under that tag (none, or a draft),
  which is not proof that the version does not exist: report it as not
  available from the mirror.
- **From `tags.json`**: a git tag need not have a release, so
  `/releases/{tag}` is the wrong question and its 404 does not mean the tag is
  missing. Page through the mirror's
  `/api/github/repos/{owner}/{repo}/tags?page=N` (100 tags a page, GitHub's
  order, up to 10 pages) until the tag appears or `next_page` is null. A
  `next_page` of null with `truncated: true` means the mirror stopped at its
  page limit with older tags left: the lookup is incomplete, so report the
  tag as not found in what the mirror holds, not as absent.

## Errors

These are the answers of the `/data/github/` URLs above. The
`/api/github/repos/...` routes are separate and answer a malformed path with
`400`.

| status | meaning | client action |
| --- | --- | --- |
| `404` | Not a valid path (including uppercase), or the repo is private, missing or blocked. | Report the tool's versions as not found. The mirror serves public repositories only. |
| `403` | The mirror is disabled or restricted (`GITHUB_MIRROR_ACCESS`). | Warn, and report the versions as unavailable. |
| `429` | This client started too many uncached crawls. | Ask `api.github.com`; if that fails too, use the list cached locally. |
| `502` | GitHub failed and there was nothing stored to serve. | Ask `api.github.com`; if that fails too, use the list cached locally. |
| `503` | The repo's visibility could not be checked. | Ask `api.github.com`; if that fails too, use the list cached locally. |

mise treats a timeout or a lost connection like a `5xx`.

**mise asks `api.github.com` only when the mirror errors**: a timeout, a lost
connection, `429` or `5xx`. It first tries the paged `/api/github/` routes
for the list, then makes the same lookup on GitHub, with the user's token if
one is set. When GitHub fails too, the error names both failures. Anything the
mirror answers is trusted: a `404`, a `403`, or an empty list never reaches
GitHub. Its unauthenticated limit (60 requests an hour) is what makes those
lookups fail for users, and avoiding that is the reason the mirror exists.

A `200` is always a complete or truncated list as described above, never a
partial error.

## Access

Only repositories GitHub reports as public are served, the same as the other
mirror routes. `GITHUB_MIRROR_ACCESS=registry` limits the mirror to repos in the
mise registry, and `off` disables it.

The Worker checks access before answering from any cache. Baked files are
served without the Worker, so the refresher checks each repo again every hour.
A repo that turns private stops being baked, and is gone within about an hour
plus the refresher's run and one deploy.

## How lists get baked

Three parts, each with its own job:

1. **The first request** for a list misses the static assets and falls
   through to the Worker. The Worker crawls the list from GitHub with a mirror
   pool token (repos get the usual visibility and access checks, and a
   per-client limit on cold crawls). It stores the compact list in KV, marks it
   as requested and as changed, and answers.
2. **The refresher** is a Worker cron trigger that runs every 10 minutes
   (`*/10`, `POST /api/admin/github/versions/refresh` in-process). Each run:
   - reads every list's state from KV list metadata;
   - refreshes the lists that are due, with conditional requests;
   - checks each repo's access every hour;
   - stops baking lists nobody has requested for 30 days, and lists whose repo
     is no longer servable;
   - records a change time for each list whose content or bake status changed.

   A run handles at most 150 lists, spends at most 3 minutes, and uses pool
   tokens only, never anonymous requests. A lease keeps overlapping runs from
   doing the same work, and runs are idempotent, so a skipped or overlapping
   run is harmless.

   When a list has changed since the last deployed bake, the run dispatches
   `deploy.yml`. It doesn't dispatch again while a dispatched deploy is still
   unacknowledged, unless that dispatch is more than 30 minutes old.
3. **Every deploy** (`deploy.yml`, whether dispatched by the refresher or by a
   catalog update) runs `scripts/bake-github-versions.js`:
   - The baked tree is kept between deploys in the Actions cache. The script
     asks `/api/admin/github/versions/changes` only for the lists changed,
     removed or refreshed since that tree's bake. Refreshed lists are rewritten
     so their `fetched_at` stays current, but only a change makes the
     refresher dispatch a deploy.
   - A deploy without a cached tree, and the first deploy each week, rebuilds
     the tree from scratch. That way a file whose KV entry expired before its
     removal was baked cannot linger.
   - It writes the tree into `web/dist/client/data/github/`, where the files
     deploy as static assets.
   - After `wrangler deploy`, it acknowledges the bake, so the refresher
     dispatches deploys only for later changes. The acknowledgement leaves out
     the last 2 minutes, because KV's list metadata can trail a write by up to a
     minute. A change made just before the bake read therefore still gets a
     deploy.

   The bake reads KV only and makes no GitHub requests. A failure or timeout
   bakes what it has and never fails the deploy; anything not baked is still
   answered by the Worker.

   Deploys queue (`cancel-in-progress: false`): one runs, and of those
   dispatched meanwhile only the newest waits.

Requests for baked files never reach the Worker. The nightly Logpush rollup
(`maintenance.yml`) reports which files mise clients fetched to
`/api/admin/github/versions/demand`, which keeps those lists marked as
requested. A list nobody has requested for 30 days is no longer baked or
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

- A page-1 refresh is a conditional probe of the newest 20 entries: a 304 (no
  rate-limit cost) when nothing changed, otherwise 1 request (plus 1 GraphQL
  point for tags), 0.4–0.8 s.
- A quiet list costs about 4 full crawls a day. An active list also costs one
  page-1 refresh per refresher run, at most 6 an hour.
- The refresher is about 144 Worker invocations a day. Each run makes about 1
  KV operation per 1,000 lists to read their state, 1 per 100 tracked repos for
  their generations, and about 4 per list it works on.
- A deploy's bake makes 1 KV list operation per 200 lists, plus bulk reads of
  the lists that changed. Measured locally under `wrangler dev` with 3,000 lists
  of about 10 KB each: a full bake took 1.7 s, a bake with no changes 0.66 s,
  and a bake with 5 updated and 2 removed lists 0.65 s (each includes copying
  the tree into the build).
- The pool had 1,330 available tokens on 2026-10-14. Tokens are benched once
  they fall to 4,000 remaining (`src/token-budget.ts`), which leaves about
  1.3 million requests an hour, far more than baking needs.
