#!/usr/bin/env bash
set -xeu #o pipefail

# cpython-3.13.1+20241206-x86_64_v4-unknown-linux-musl-install_only_stripped.tar.gz
# cpython-3.13.1+20241206-i686-pc-windows-msvc-shared-install_only_stripped.tar.gz

releases=$(gh api graphql -f query="
    query {
      repository(owner: \"indygreg\", name: \"python-build-standalone\") {
        releases(first: $1) {
           nodes { name }
         }
      }
    }" --jq '.[].repository.releases.nodes.[].name')

for release in $releases; do
	assets=$(gh api graphql --paginate -f query="
    query(\$endCursor: String) {
      repository(owner: \"indygreg\", name: \"python-build-standalone\") {
        release(tagName: \"$release\") {
          releaseAssets(first: 100, after: \$endCursor) {
            nodes { name }
            pageInfo { hasNextPage, endCursor }
          }
        }
      }
    }" --jq '.[].repository.release.releaseAssets.nodes.[].name' | grep -E '\.tar\.(gz|zst)$')
	echo "$assets" >>docs/python-precompiled
done

grep '^cpython-' docs/python-precompiled \
  | sed -E 's/^cpython-//' \
  | sort -uV \
  | sed 's/^/cpython-/' \
  >docs/python-precompiled.tmp
mv docs/python-precompiled.tmp docs/python-precompiled
platforms=$(sed -E 's/^cpython-([0-9]+\.?)+\+[0-9]+-(.*)-install_only_stripped.*/\2/g' docs/python-precompiled | grep -v cpython | sort -u)

for platform in $platforms; do
  grep "\-$platform-" docs/python-precompiled >"docs/python-precompiled-$platform"
  if ! git diff --quiet "docs/python-precompiled-$platform"; then
    gzip -9c "docs/python-precompiled-$platform" >"docs/python-precompiled-$platform.gz"
  fi
done

if ! git diff --quiet "docs/python-precompiled"; then
  gzip -9c "docs/python-precompiled" >"docs/python-precompiled.gz"
fi
git add docs/python-precompiled*
