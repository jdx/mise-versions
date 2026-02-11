#!/usr/bin/env bash
# shellcheck disable=SC2005
set -euxo pipefail

if [ "${DRY_RUN:-}" == 0 ]; then
	git config --local user.email "189793748+mise-en-versions@users.noreply.github.com"
	git config --local user.name "mise-en-versions"
fi

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

if [ "${DRY_RUN:-}" == 0 ] && ! git diff-index --cached --quiet HEAD; then
	git diff --compact-summary --cached

	# Count the number of tools in aqua-registry for a more descriptive commit message
	tools_count=$(wc -l <docs/aqua-registry/all 2>/dev/null || echo "0")

	if [ "$tools_count" -gt 0 ]; then
		commit_msg="aqua-registry: update registry with $tools_count tools"
	else
		commit_msg="aqua-registry"
	fi

	git commit -m "$commit_msg"
	git pull --autostash --rebase origin main
	git push
fi
