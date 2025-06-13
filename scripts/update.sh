#!/usr/bin/env bash
# shellcheck disable=SC1091
source env_parallel.bash
set -euxo pipefail

export MISE_NODE_MIRROR_URL="https://nodejs.org/dist/"
export MISE_USE_VERSIONS_HOST=0
export MISE_LIST_ALL_VERSIONS=1
export MISE_LOG_HTTP=1

if [ "${DRY_RUN:-}" == 0 ]; then
	git config --local user.email "189793748+mise-en-versions@users.noreply.github.com"
	git config --local user.name "mise-en-versions"
fi

fetch() {
	if [ -f /tmp/mise_403 ]; then
		return
	fi
	case "$1" in
	awscli-local) # TODO: remove this when it is working
		echo "Skipping $1"
		return
		;;
	jfrog-cli | minio | tiny | teleport-ent | flyctl | flyway | vim | awscli | aws | aws-cli | checkov | snyk | chromedriver | sui | rebar)
		echo "Skipping $1"
		return
		;;
	esac
	mise x -- wait-for-gh-rate-limit || true
	echo "Fetching $1"
	if ! docker run -e GITHUB_API_TOKEN -e MISE_USE_VERSIONS_HOST -e MISE_LIST_ALL_VERSIONS -e MISE_LOG_HTTP -e MISE_EXPERIMENTAL -e MISE_TRUSTED_CONFIG_PATHS=/ \
		jdxcode/mise -y ls-remote "$1" >"docs/$1" 2> >(tee /dev/stderr | grep -q "403 Forbidden" && echo "403" >/tmp/mise_403); then
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
tools="$(docker run -e MISE_EXPERIMENTAL=1 jdxcode/mise registry | awk '{print $1}')"
echo "$tools" | sort -R | head -n 100 | env_parallel -j4 --env fetch fetch {} || true

if [ "${DRY_RUN:-}" == 0 ] && ! git diff-index --cached --quiet HEAD; then
	git diff --compact-summary --cached
	git commit -m "versions"
	git pull --autostash --rebase origin main
	git push
fi
