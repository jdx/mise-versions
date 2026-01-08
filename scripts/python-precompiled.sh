#!/usr/bin/env bash
set -xeu #o pipefail

# cpython-3.13.1+20241206-x86_64_v4-unknown-linux-musl-install_only_stripped.tar.gz
# cpython-3.13.1+20241206-i686-pc-windows-msvc-shared-install_only_stripped.tar.gz

# Create temp directory for .gz files (will be uploaded to R2 separately)
GZ_DIR="${GZ_DIR:-/tmp/python-precompiled-gz}"
mkdir -p "$GZ_DIR"
rm -f "$GZ_DIR"/*.gz

# Paginate through all releases
releases=$(gh api graphql --paginate -f query='
    query($endCursor: String) {
      repository(owner: "indygreg", name: "python-build-standalone") {
        releases(first: 100, after: $endCursor) {
           nodes { name }
           pageInfo { hasNextPage, endCursor }
         }
      }
    }' --jq '.data.repository.releases.nodes.[].name')

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
  # Generate .gz to temp directory (not git repo)
  gzip -9c "docs/python-precompiled-$platform" >"$GZ_DIR/python-precompiled-$platform.gz"

  # Generate TOML file for this platform
  toml_file="docs/python-precompiled-$platform.toml"
  while read -r v; do
    [ -n "$v" ] && echo "{\"version\":\"$v\"}"
  done < "docs/python-precompiled-$platform" | node scripts/generate-toml.js "python-precompiled-$platform" "$toml_file" > "$toml_file.tmp" && mv "$toml_file.tmp" "$toml_file"
done

# Generate main .gz file
gzip -9c "docs/python-precompiled" >"$GZ_DIR/python-precompiled.gz"

# Add TOML files to git (not plain text files)
git add docs/python-precompiled-*.toml
# Remove any .gz files that might have been tracked previously
git rm -f --ignore-unmatch docs/python-precompiled*.gz 2>/dev/null || true
# Remove main plain text file from git if it was tracked
git rm -f --ignore-unmatch docs/python-precompiled 2>/dev/null || true
# Clean up plain text files from filesystem (these are intermediate files, never added to git)
for platform in $platforms; do
  rm -f "docs/python-precompiled-$platform"
done
rm -f docs/python-precompiled

echo "Generated .gz files in $GZ_DIR:"
ls -la "$GZ_DIR"/*.gz
