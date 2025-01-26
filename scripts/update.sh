#!/usr/bin/env bash
# shellcheck disable=SC1091
source env_parallel.bash
set -euxo pipefail

export MISE_NODE_MIRROR_URL="https://nodejs.org/dist/"
export MISE_USE_VERSIONS_HOST=0
export MISE_LIST_ALL_VERSIONS=1

fetch() {
	case "$1" in
	awscli-local) # TODO: remove this when it is working
		echo "Skipping $1"
		return
		;;
	jfrog-cli | minio | tiny | teleport-ent | flyctl | flyway | vim | awscli | checkov | snyk | chromedriver | sui)
		echo "Skipping $1"
		return
		;;
	esac
	echo "Fetching $1"
	if ! docker run -e GITHUB_API_TOKEN -e MISE_USE_VERSIONS_HOST -e MISE_LIST_ALL_VERSIONS -e MISE_EXPERIMENTAL -e MISE_TRUSTED_CONFIG_PATHS=/ \
		jdxcode/mise -y ls-remote "$1" >"docs/$1"; then
		echo "Failed to fetch versions for $1"
		rm -f "docs/$1"
		return
	fi
	new_lines=$(wc -l <"docs/$1")
	if [ ! "$new_lines" -gt 1 ]; then
		echo "No versions for $1" >/dev/null
		rm -f "docs/$1"
	else
		case "$1" in
		cargo-binstall)
			mv docs/cargo-binstall{,.tmp}
			grep -E '^[0-9]' docs/cargo-binstall.tmp >docs/cargo-binstall
			rm docs/cargo-binstall.tmp
			git add "docs/$1"
			;;
		rust)
			if [ "$new_lines" -gt 10 ]; then
				git add "docs/$1"
			fi
			;;
		java)
			sort -V "docs/$1" -o "docs/$1"
			git add "docs/$1"
			;;
		vault | consul | nomad | terraform | packer | vagrant | boundary | protobuf)
			mv "docs/$1"{,.tmp}
			grep -E '^[0-9]' "docs/$1.tmp" >"docs/$1"
			rm "docs/$1.tmp"
			sort -V "docs/$1" -o "docs/$1"
			git add "docs/$1"
			;;
		*)
			git add "docs/$1"
			;;
		esac
	fi
}

docker run jdxcode/mise -v
docker run -e MISE_EXPERIMENTAL=1 jdxcode/mise registry | awk '{print $1}' | env_parallel -j4 --env fetch fetch {} || true

git clone https://github.com/aquaproj/aqua-registry --depth 1
fd . -tf -E registry.yaml aqua-registry -X rm
rm -rf docs/aqua-registry
cp -r aqua-registry/pkgs/ docs/aqua-registry
rm -rf aqua-registry
for f in $(cd docs/aqua-registry && fd registry.yaml); do
  for a in $(yq '.packages[].aliases[].name' "docs/aqua-registry/$f"); do
    mkdir -p "docs/aqua-registry/$a"
    cp "docs/aqua-registry/$f" "docs/aqua-registry/$a/registry.yaml"
  done
done
echo "$(cd docs/aqua-registry && fd --format '{//}' registry.yaml | sort -u)" >docs/aqua-registry/all
git add docs/aqua-registry

if [ "$DRY_RUN" == 0 ] && ! git diff-index --cached --quiet HEAD; then
	git diff --compact-summary --cached
	git config --local user.email "189793748+mise-en-versions@users.noreply.github.com"
	git config --local user.name "mise-en-versions"
	git commit -m "Update release metadata"
	git push
fi
