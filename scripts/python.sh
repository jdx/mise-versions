#!/usr/bin/env bash
# shellcheck disable=SC1091
set -euxo pipefail

if [ "${DRY_RUN:-}" == 0 ]; then
	git config --local user.email "189793748+mise-en-versions@users.noreply.github.com"
	git config --local user.name "mise-en-versions"
fi

cp docs/python-precompiled python-precompiled
rm -rf docs
mkdir -p docs
mv python-precompiled docs/python-precompiled
./scripts/python-precompiled.sh 1

if [ "${DRY_RUN:-}" == 0 ] && ! git diff-index --cached --quiet HEAD; then
	git diff --compact-summary --cached
	
	# Count the python-precompiled files for a more descriptive commit message
	precompiled_files=$(find docs -name "python-precompiled*" -type f | wc -l)
	platform_count=$(find docs -name "python-precompiled-*" -not -name "*.gz" -type f | wc -l)
	
	if [ "$platform_count" -gt 0 ]; then
		commit_msg="python-precompiled: update $platform_count platforms ($precompiled_files total files)"
	else
		commit_msg="python-precompiled"
	fi
	
	git commit -m "$commit_msg"
	git pull --autostash --rebase origin main
	git push
fi 
