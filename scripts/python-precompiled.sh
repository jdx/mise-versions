#!/usr/bin/env bash
set -xeu #o pipefail

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
    }" --jq '.[].repository.release.releaseAssets.nodes.[].name' | grep install_only | grep -ve '\.sha256$')
  echo "$assets" >> docs/python-precompiled
done

sort -uV >docs/python-precompiled.tmp <docs/python-precompiled
mv docs/python-precompiled.tmp docs/python-precompiled
git add docs/python-precompiled
