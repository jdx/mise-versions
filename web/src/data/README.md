# Ecosystem snapshots

`mise-adoption.json` comes from the public `jdx/mise-analytics` repository's
`mise.csv`. Homebrew observations are rolling 30-day **install-on-request**
counts, ranks, and shares; they are not daily counts or unique users.

`packslip.json` is discovered from the latest stable GitHub releases of tools in
the public directory. Before including a release, the collector uses the pinned
Packslip CLI to verify the Sigstore signature and transparency log against the
canonical repository's GitHub Actions identity. It checks the project, vendor
status, and source tag. Repository transfers are resolved through GitHub's API.
Resource commands are never executed. Binary contents and linked provenance
attestations are not verified by this collector.

Only root GitHub projects with `packslip.sigstore.json` are currently discovered.
Domain projects, monorepo manifests, and other forges need their own discovery
and identity binding before they can be included. Missing manifests remove the
badge; refresh errors preserve the last successful snapshot and fail the job.

The `ecosystem metadata` workflow refreshes both snapshots daily and deploys any
changes. To refresh selected repositories locally (requires Packslip 1.1.1):

```sh
aube exec tsx scripts/update-ecosystem.ts jdx/hk jdx/usage
```

Omit repository arguments to scan the entire directory. `GH_TOKEN` avoids
GitHub's unauthenticated API limit; `PACKSLIP_BIN` can select the verifier path.
The UI awards a Packslip badge based on the verified manifest, independently of
the registry's existing security badges. Capabilities describe the displayed
release, not every historical version.

`mise-downloads.json` selects only `mise` from `top-repos-downloads.csv`. These
are cumulative GitHub release-asset counters (all assets, not just executables).
The 30-day change requires an exact dated baseline and is omitted when counters
decrease. `mise-stars.json` selects mise and Homebrew from `competitors.csv`,
retaining two years of observations. The crossover forecast uses the existing
MAU forecast's blended 7-, 30-, and 365-day pace for **both** repositories; the
Homebrew target keeps growing. Forecasts are estimates, not scheduled events.

The downloads chart shows daily increases between consecutive dated snapshots,
not cumulative totals. The first observation, missing days, and negative counter
corrections have no daily value; genuine zero increases remain zero. The headline
uses the latest day's increase, and the chart shows the latest 90 observations.
