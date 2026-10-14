# GitHub versions listing (format 1)

One request returns a public GitHub repository's whole release list, or its
whole tag list, in compact form. It replaces paging through
`api.github.com/repos/{owner}/{repo}/releases` or `/tags` (or the mirror's
`/releases?page=N` and `/tags?page=N`) when mise lists the versions of a
`github:`, `aqua:` or `packslip:` tool.

This document is the client contract. The server is
[`web/src/lib/github/versions.ts`](../web/src/lib/github/versions.ts) and
[`web/src/pages/api/github/repos/[owner]/[repo]/versions/index.ts`](../web/src/pages/api/github/repos/[owner]/[repo]/versions/index.ts),
tested in [`scripts/github-versions.test.js`](../scripts/github-versions.test.js).

## Request

```
GET https://mise-versions.jdx.dev/api/github/repos/{owner}/{repo}/versions
    ?source=releases|tags        (default: releases)
    &asset=NAME                  (optional, releases only)
```

- `owner` and `repo` are path segments matching `[A-Za-z0-9_.-]+`. Percent-encode
  them as the release endpoints do. The repo may be under a former name; GitHub's
  redirect is followed.
- `source=releases` lists GitHub releases. `source=tags` lists git tags.
- `asset=NAME` (releases only) keeps only the releases that carry an asset with
  exactly this name, for example `packslip.sigstore.json`. The name must match
  `[A-Za-z0-9._+@~-]{1,255}`.
- Other query parameters are ignored and do not affect caching.

## Response

`200`, `Content-Type: application/json`. Cloudflare compresses according to
`Accept-Encoding`.

### `source=releases`

```json
{
  "source": "releases",
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
| `tag` | The release's `tag_name`. |
| `date` | `published_at`, or `created_at` when GitHub has no `published_at`. This is mise's `GithubRelease::released_at()`. |
| `prerelease` | GitHub's `prerelease` flag. |
| `asset_count` | How many assets the release has. `0` is a release mise's github backend drops (`github_release_has_assets`) unless the tool has a direct `url`. |

Drafts are never included.

### `source=tags`

```json
{
  "source": "tags",
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
openai/codex's 1,226 releases are out of creation order. Tags are sorted by name, highest
version first. Clients that today use the REST order (for example the github
backend, which reverses it) can use this order unchanged. Do not re-sort by
`date`.

### Truncation

`truncated: false` means the list is complete.

`truncated: true` means the list is a **newest-first prefix**: every entry
present is in its correct place, and older entries exist that are not listed.
This happens when:

- the repository has more than 20 pages (2,000 entries), or
- GitHub could not serve all pages within the server's 20-second crawl budget.
  So far this only happens for openai/codex, where each REST page is about 32 MB
  and takes GitHub around 8 s, so the server keeps 100–200 releases. It can also
  happen if GitHub fails part-way through a crawl.

What a client should do with a truncated list:

- **Resolving `latest` or a prefix such as `1.2`** can use the prefix whenever it
  contains a matching stable entry. This is the same rule
  `has_stopping_stable_release` uses to stop paging today.
- **Listing every version** (`MISE_LIST_ALL_VERSIONS`, `mise ls-remote --all`)
  needs the rest from GitHub. The mirror's `/releases?page=N` and `/tags?page=N`
  stop at page 10, so go to `api.github.com`.

## Freshness

| | releases | tags |
| --- | --- | --- |
| Page 1 (new entries) re-read after | 10 min. For repos the catalog tracks, 10 min to 6 h while nothing changes, and immediately when a release is published (see below). | 10 min |
| Full re-crawl (edits and deletions past page 1) | 6 h | 1 h |

- **New releases.** For a repo the mise-versions catalog tracks, a newly
  published release rotates the repo's release generation, which is the same
  signal that refreshes `/releases/latest`. The next request then reads page 1
  again. The catalog syncs every 15 minutes, and edge caches pick up a new
  generation within about 60 s. For untracked repos, page 1 is at most 10 minutes
  old, the same as an untracked `/releases/latest`.
- **Repos with no recent change.** For tracked repos, page 1 is re-read less
  often while the list stays the same: after a quarter of the time it has been
  unchanged, capped at 6 hours. A new release still shows up through the
  generation. Untracked repos and tag lists always use 10 minutes.
- **Cache headers.** Responses carry `Cache-Control: public, max-age=0,
  s-maxage=N`, where N is the time left before the list is due for a refresh.
  While the server refreshes in the background, N is 60, so the stored list is
  served for at most another minute.
- **Client caching.** Clients keep their own copy for as long as any remote
  version list (`fetch_remote_versions_cache`, default 1 h), as today.

Releases further down the list than page 1 can be up to 6 hours behind GitHub,
for example an asset count after a late re-upload, or a deleted release. Page 1
is never more than 10 minutes behind.

## Errors

| status | meaning | client action |
| --- | --- | --- |
| `400` | Bad path, `source`, `asset`, or `asset` with `source=tags`. | Bug: log it and use GitHub. |
| `403` | The mirror is disabled or restricted (`GITHUB_MIRROR_ACCESS`). | Warn and use GitHub, as for releases. |
| `404` | The repo is private, missing, or blocked. | Use GitHub quietly, as for releases. |
| `429` | This client started too many uncached crawls. | Use GitHub for this tool. |
| `502` | GitHub failed and there was nothing stored to serve. | Use GitHub. |
| `503` | The repo's visibility could not be checked. | Use GitHub. |

A `200` is always a complete or truncated list as described above, never a
partial error.

## Access

The rules are the same as for the other mirror routes. Only repositories GitHub
reports as public are served, checked before any cached answer is returned.
`GITHUB_MIRROR_ACCESS=registry` limits the mirror to repos in the mise registry,
and `off` disables it.

## Which client uses what

| caller (jdx/mise) | request |
| --- | --- |
| github backend `_list_remote_versions` (`list_releases_including_prereleases_from_url` on github.com) | `?source=releases`. Drop `asset_count == 0` unless the tool has a direct `url`. |
| aqua, release-based packages (`get_tags_with_release_dates`) | `?source=releases`. `package_has_asset` reads the aqua registry, not release assets. |
| aqua `version_source: github_tag`, ubi tags (`list_tags`, `list_tags_from_url` on github.com) | `?source=tags` |
| go with `MISE_LIST_ALL_VERSIONS` (`list_tags_with_dates`) | `?source=tags` |
| packslip `vendor_versions` | `?source=releases&asset=<bundle_name(project)>` |

The github backend's `security_info` reads asset names of the newest stable
release. It should use `/releases/latest` (or `/releases/{tag}`), not this
listing.

## Cost and size

Measured 2026-10-14 from a local run of the server code against GitHub, with
one pool token:

| repo | source | entries | truncated | cold miss | GitHub requests (REST + GraphQL) | raw | gzip | brotli |
| --- | --- | ---: | --- | ---: | --- | ---: | ---: | ---: |
| jqlang/jq | releases | 16 | no | 0.7 s | 1 | 1.4 KB | 0.3 KB | 0.3 KB |
| BurntSushi/ripgrep | releases | 75 | no | 0.7 s | 1 | 6.0 KB | 1.0 KB | 0.7 KB |
| cli/cli | releases | 205 | no | 2.9 s | 3 | 16.8 KB | 2.4 KB | 1.6 KB |
| kubernetes/kubernetes | releases | 821 | no | 1.8 s | 9 | 68.0 KB | 8.8 KB | 6.5 KB |
| zed-industries/zed | releases | 1,311 | no | 4.1 s | 14 | 109.6 KB | 13.5 KB | 9.1 KB |
| openai/codex | releases | 100–200 | yes | ~20 s | 2–3 | 19 KB | 2.3 KB | 1.6 KB |
| apache/tomcat | tags | 540 | no | 1.9 s | 6 + 6 | 51.0 KB | 18.8 KB | 15.4 KB |
| golang/go | tags | 498 | no | 1.7 s | 5 + 5 | 48.7 KB | 17.1 KB | 14.2 KB |

- A refresh of page 1 costs 1 request (plus 1 GraphQL point for tags) and takes
  0.4–2 s. For openai/codex it takes about 9 s. Refreshes run in the background
  while the stored list is served, so only a cold miss waits on GitHub.
- A cold miss happens once per repo and source globally: the result lives in KV
  for 30 days and is refreshed from there.
- Tag dates cost 1 GraphQL point per 100 tags, from the token's separate GraphQL
  budget. Without the mirror, `list_tags_with_dates` makes one REST request per
  tag.
