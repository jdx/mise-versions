#!/usr/bin/env bash
# shellcheck disable=SC1091
set -euxo pipefail

if [ "${DRY_RUN:-}" == 0 ]; then
	git config --local user.email "189793748+mise-en-versions@users.noreply.github.com"
	git config --local user.name "mise-en-versions"
fi

# Preserve existing python-precompiled TOML files before clearing docs
mkdir -p /tmp/python-precompiled-backup
cp docs/python-precompiled*.toml /tmp/python-precompiled-backup/ 2>/dev/null || true
rm -rf docs
mkdir -p docs
mv /tmp/python-precompiled-backup/*.toml docs/ 2>/dev/null || true
rmdir /tmp/python-precompiled-backup 2>/dev/null || true
./scripts/python-precompiled.sh 100

if [ "${DRY_RUN:-}" == 0 ] && ! git diff-index --cached --quiet HEAD; then
	git diff --compact-summary --cached
	
	# Count the python-precompiled TOML files for a more descriptive commit message
	precompiled_files=$(find docs -name "python-precompiled*.toml" -type f | wc -l)
	platform_count=$precompiled_files
	
	if [ "$platform_count" -gt 0 ]; then
		commit_msg="python-precompiled: update $platform_count platforms ($precompiled_files total files)"
	else
		commit_msg="python-precompiled"
	fi
	
	git commit -m "$commit_msg"
	git pull --autostash --rebase origin main
	git push
fi 
