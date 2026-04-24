#!/usr/bin/env bash
# shellcheck disable=SC2129
set -euo pipefail

export MISE_NODE_MIRROR_URL="https://nodejs.org/dist/"
export MISE_USE_VERSIONS_HOST=0
export MISE_LIST_ALL_VERSIONS=1
export MISE_LOG_HTTP=1

# GitHub Token Manager configuration
export TOKEN_MANAGER_URL="$TOKEN_MANAGER_URL"
export TOKEN_MANAGER_SECRET="$TOKEN_MANAGER_SECRET"

# ============================================================================
# Structured Logging
# ============================================================================
# Outputs structured log messages with timestamps and levels.
# In GitHub Actions, logs are formatted for better visibility in the UI.
# ============================================================================

LOG_LEVEL="${LOG_LEVEL:-INFO}"

# Get log level priority (works in subshells without associative arrays)
get_log_priority() {
	case "$1" in
	DEBUG) echo 0 ;;
	INFO) echo 1 ;;
	WARN) echo 2 ;;
	ERROR) echo 3 ;;
	*) echo 1 ;;
	esac
}

# Check if we should log at a given level
should_log() {
	local level="$1"
	local current_priority
	local msg_priority
	current_priority=$(get_log_priority "$LOG_LEVEL")
	msg_priority=$(get_log_priority "$level")
	[ "$msg_priority" -ge "$current_priority" ]
}

# Format timestamp in ISO 8601
log_timestamp() {
	date -u '+%Y-%m-%dT%H:%M:%SZ'
}

# Main logging function
# Usage: log LEVEL "message" [key=value ...]
log() {
	local level="$1"
	shift
	local message="$1"
	shift

	# Check if we should log at this level
	if ! should_log "$level"; then
		return
	fi

	local timestamp
	timestamp=$(log_timestamp)

	# Build context string from remaining args
	local context=""
	if [ $# -gt 0 ]; then
		context=" [$*]"
	fi

	# Format based on environment
	# All log output goes to stderr to avoid polluting command substitution
	if [ -n "${GITHUB_ACTIONS:-}" ]; then
		# GitHub Actions format with grouping support
		case "$level" in
		ERROR)
			echo "::error::[$timestamp] $message$context" >&2
			;;
		WARN)
			echo "::warning::[$timestamp] $message$context" >&2
			;;
		DEBUG)
			echo "::debug::[$timestamp] $message$context" >&2
			;;
		*)
			echo "[$timestamp] [$level] $message$context" >&2
			;;
		esac
	else
		# Standard terminal format with colors
		local color=""
		local reset="\033[0m"
		case "$level" in
		ERROR) color="\033[0;31m" ;; # Red
		WARN) color="\033[0;33m" ;;  # Yellow
		INFO) color="\033[0;32m" ;;  # Green
		DEBUG) color="\033[0;36m" ;; # Cyan
		esac
		echo -e "${color}[$timestamp] [$level]${reset} $message$context" >&2
	fi
}

# Convenience functions
log_debug() { log DEBUG "$@"; }
log_info() { log INFO "$@"; }
log_warn() { log WARN "$@"; }
log_error() { log ERROR "$@"; }

# Start a log group (GitHub Actions collapsible section)
log_group_start() {
	local title="$1"
	if [ -n "${GITHUB_ACTIONS:-}" ]; then
		echo "::group::$title" >&2
	else
		log_info "=== $title ==="
	fi
}

# End a log group
log_group_end() {
	if [ -n "${GITHUB_ACTIONS:-}" ]; then
		echo "::endgroup::" >&2
	fi
}

# Statistics tracking variables - now using files
STATS_DIR="/tmp/mise_stats_$$"
mkdir -p "$STATS_DIR"

# Counter files (append-only, one byte per increment for atomic parallel writes)
# Appending a single byte under PIPE_BUF is atomic on POSIX systems, which lets
# many parallel workers race on the same counter without locks.
COUNTERS=(
	total_tools_checked
	total_tools_updated
	total_tools_skipped
	total_tools_failed
	total_tools_no_versions
	total_tokens_used
	total_rate_limits_hit
)
for counter in "${COUNTERS[@]}"; do
	: >"$STATS_DIR/$counter"
done

# String stats (set_stat only, not incremented concurrently)
echo "0" >"$STATS_DIR/total_tools_available"
echo "" >"$STATS_DIR/updated_tools_list"
echo "false" >"$STATS_DIR/summary_generated"
START_TIME=$(date +%s)
echo "$START_TIME" >"$STATS_DIR/start_time"

# Atomic increment — appends a single byte to the counter file.
increment_stat() {
	printf '.' >>"$STATS_DIR/$1"
}

# Read a stat. Counter files contain only dots; we return the byte count.
# String files contain arbitrary text; we return the content.
get_stat() {
	local stat_file="$STATS_DIR/$1"
	[ -e "$stat_file" ] || {
		echo "0"
		return
	}
	local content
	content=$(cat "$stat_file" 2>/dev/null || echo "")
	if [ -z "$content" ] || [[ "$content" =~ ^\.+$ ]]; then
		wc -c <"$stat_file" | tr -d ' '
	else
		echo "$content"
	fi
}

# Append a tool name to the updated list. One tool per line.
add_to_list() {
	echo "$1" >>"$STATS_DIR/updated_tools_list"
}

set_stat() {
	local stat_file="$STATS_DIR/$1"
	local value="$2"
	# Silently fail if stats directory was cleaned up
	[ -d "$STATS_DIR" ] && echo "$value" >"$stat_file" || true
}

# Cleanup function
cleanup_stats() {
	rm -rf "$STATS_DIR"
	[ -n "${RESULTS_DIR:-}" ] && rm -rf "$RESULTS_DIR"
}

# Set trap to cleanup on exit
trap cleanup_stats EXIT

if [ "${DRY_RUN:-}" == 0 ]; then
	git config --local user.email "189793748+mise-en-versions@users.noreply.github.com"
	git config --local user.name "mise-en-versions"
fi

# Function to generate GitHub Actions summary
generate_summary() {
	# Only generate summary once
	if [ "$(get_stat "summary_generated")" = "true" ]; then
		return
	fi

	local end_time
	end_time=$(date +%s)
	local duration=$((end_time - START_TIME))
	local duration_minutes=$((duration / 60))
	local duration_seconds=$((duration % 60))
	local commit_hash
	commit_hash=$(git rev-parse HEAD 2>/dev/null || echo "main")

	# Create summary file
	cat >summary.md <<SUMMARY_EOF
# 📊 Mise Versions Update Summary

**Generated**: $(date '+%Y-%m-%d %H:%M:%S UTC')
**Commit**: [${commit_hash}](https://github.com/jdx/mise-versions/commit/${commit_hash})

## 📊 Quick Stats
| Metric | Value |
|--------|-------|
| Tools Processed | $(get_stat "total_tools_checked") |
| Tools Updated | $(get_stat "total_tools_updated") |
| Success Rate | $([ "$(get_stat "total_tools_checked")" -gt 0 ] && echo "$((($(get_stat "total_tools_updated") * 100) / $(get_stat "total_tools_checked")))" || echo "0")% |
| Tokens Used | $(get_stat "total_tokens_used") |
| Rate Limits Hit | $(get_stat "total_rate_limits_hit") |
| Duration | ${duration_minutes}m ${duration_seconds}s |

## 🎯 Overview
- **Total Tools Checked**: $(get_stat "total_tools_checked")
- **Tools Updated**: $(get_stat "total_tools_updated")
- **Tools Skipped**: $(get_stat "total_tools_skipped")
- **Tools Failed**: $(get_stat "total_tools_failed")
- **Tools with No Versions**: $(get_stat "total_tools_no_versions")
- **Tokens Used**: $(get_stat "total_tokens_used")
- **Rate Limits Hit**: $(get_stat "total_rate_limits_hit")
- **Duration**: ${duration_minutes}m ${duration_seconds}s
- **Mise Version**: ${CUR_MISE_VERSION:-not set}

## 📈 Success Rate
- **Success Rate**: $([ "$(get_stat "total_tools_checked")" -gt 0 ] && echo "$((($(get_stat "total_tools_updated") * 100) / $(get_stat "total_tools_checked")))" || echo "0")%
- **Update Rate**: $([ "$(get_stat "total_tools_checked")" -gt 0 ] && echo "$((($(get_stat "total_tools_updated") * 100) / $(get_stat "total_tools_checked")))" || echo "0")%
- **Coverage**: $([ "$(get_stat "total_tools_available")" -gt 0 ] && echo "$((($(get_stat "total_tools_checked") * 100) / $(get_stat "total_tools_available")))" || echo "0")%

## 🔧 Token Management
- **Tokens Consumed**: $(get_stat "total_tokens_used")
- **Rate Limit Events**: $(get_stat "total_rate_limits_hit")

## 📋 Details
- **Tools Available**: $(get_stat "total_tools_available")
- **Tools Processed**: $(get_stat "total_tools_checked")
- **Tools with Updates**: $(get_stat "total_tools_updated")
- **Tools Skipped**: $(get_stat "total_tools_skipped")
- **Tools Failed**: $(get_stat "total_tools_failed")
- **Tools with No Versions**: $(get_stat "total_tools_no_versions")
- **Total Duration**: ${duration_minutes}m ${duration_seconds}s
- **Parallel Workers**: ${PARALLEL_FETCHES:-8}

## 📊 Performance Metrics
- **Processing Speed**: $([ "$duration" -gt 0 ] && [ "$((duration / 60))" -gt 0 ] && echo "$(($(get_stat "total_tools_checked") / (duration / 60)))" || echo "0") tools/minute
- **Update Speed**: $([ "$duration" -gt 0 ] && [ "$((duration / 60))" -gt 0 ] && echo "$(($(get_stat "total_tools_updated") / (duration / 60)))" || echo "0") updates/minute
- **Token Efficiency**: $([ "$(get_stat "total_tokens_used")" -gt 0 ] && echo "$(($(get_stat "total_tools_checked") / $(get_stat "total_tokens_used")))" || echo "0") tools per token

## 📦 Updated Tools ($(get_stat "total_tools_updated"))
SUMMARY_EOF

	# Add updated tools list if any tools were updated
	local updated_tools_list
	updated_tools_list=$(cat "$STATS_DIR/updated_tools_list" 2>/dev/null || echo "")
	if [ -n "$updated_tools_list" ]; then
		echo "" >>summary.md
		echo "The following tools were updated:" >>summary.md
		echo "" >>summary.md
		for tool in $updated_tools_list; do
			# Link to the local docs file
			echo "- [$tool](https://github.com/jdx/mise-versions/blob/${commit_hash}/docs/${tool}.toml)" >>summary.md
		done
	else
		echo "" >>summary.md
		echo "No tools were updated in this run." >>summary.md
	fi

	# Output to GitHub Actions summary
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		cat summary.md >>"$GITHUB_STEP_SUMMARY"
	fi

	echo "📊 Summary generated:"
	cat summary.md
	set_stat "summary_generated" "true"
}

# Function to mark a token as rate-limited
mark_token_rate_limited() {
	local token_id="$1"
	local reset_time="${2:-}"

	if [ -z "$TOKEN_MANAGER_URL" ] || [ -z "$TOKEN_MANAGER_SECRET" ]; then
		return
	fi

	increment_stat "total_rate_limits_hit"

	# Mark token as rate-limited asynchronously
	{
		node scripts/github-token.js mark-rate-limited "$token_id" "$reset_time" || true
	} &
}

# Function to generate TOML file with timestamps.
# Does NOT run `git add` — the git index is a shared resource and must be
# updated serially in the parent after all parallel workers finish.
generate_toml_file() {
	local tool="$1"
	local token="$2"
	local toml_file="docs/$tool.toml"
	local versions_file="docs/$tool"

	# Check if versions file exists
	if [ ! -f "$versions_file" ]; then
		return
	fi

	local error_output
	error_output=$(mktemp)

	# Try to get JSON with timestamps from mise ls-remote --json
	local json_output
	if json_output=$(mise ls-remote --json "$tool" 2>/dev/null) && [ -n "$json_output" ]; then
		# Convert JSON array to NDJSON and pipe to generate-toml.js
		if echo "$json_output" | node -e '
			const data = JSON.parse(require("fs").readFileSync(0, "utf-8"));
			data.forEach(v => console.log(JSON.stringify(v)));
		' | node scripts/generate-toml.js "$tool" "$toml_file" >"$toml_file.tmp" 2>"$error_output"; then
			mv "$toml_file.tmp" "$toml_file"
			rm -f "$error_output"
			return
		fi
	fi

	# Fall back to plain text conversion (preserves existing timestamps)
	if node -e '
		const fs = require("fs");
		const versions = fs.readFileSync(process.argv[1], "utf-8").trim().split("\n").filter(v => v);
		versions.forEach(v => console.log(JSON.stringify({version: v})));
	' "$versions_file" | node scripts/generate-toml.js "$tool" "$toml_file" >"$toml_file.tmp" 2>"$error_output"; then
		mv "$toml_file.tmp" "$toml_file"
		rm -f "$error_output"
	else
		echo "Warning: Failed to generate TOML for $tool" >&2
		if [ -s "$error_output" ]; then
			cat "$error_output" >&2
		fi
		rm -f "$toml_file.tmp" "$error_output"
	fi
}

# Function to get a fresh GitHub token from the token manager
get_github_token() {
	if [ -z "$TOKEN_MANAGER_URL" ] || [ -z "$TOKEN_MANAGER_SECRET" ]; then
		log_error "TOKEN_MANAGER_URL and TOKEN_MANAGER_SECRET not set"
		return 1
	fi

	increment_stat "total_tokens_used"

	local token_output
	if ! token_output=$(node scripts/github-token.js get-token); then
		log_error "No tokens available"
		return 1
	fi

	echo "$token_output"
	return 0
}

# Fetch versions for a single tool. Safe for concurrent execution.
# Writes a status file to $RESULTS_DIR/$tool.status with one of:
#   skipped, failed, no_versions, fetched
# Does NOT touch the git index or mutate counters directly — aggregation
# happens in the parent after all workers finish.
#
# Args: $1 = tool name, $2 = attempt number (internal, defaults to 1)
FETCH_MAX_ATTEMPTS=3
fetch() {
	local tool="$1"
	local attempt="${2:-1}"
	local status_file="$RESULTS_DIR/$tool.status"

	case "$tool" in
	awscli-local | jfrog-cli | minio | tiny | teleport-ent | flyctl | flyway | vim | awscli | aws | aws-cli | checkov | snyk | chromedriver | sui | rebar | dasel | cockroach)
		echo "skipped" >"$status_file"
		return
		;;
	esac

	# Get a fresh token for this fetch operation
	local token_info
	if ! token_info=$(get_github_token); then
		log_warn "No tokens available, skipping" "tool=$tool"
		echo "failed" >"$status_file"
		return 1
	fi
	local token
	local token_id

	# Parse token and token_id from the response
	if [[ "$token_info" == *" "* ]]; then
		token=$(echo "$token_info" | cut -d' ' -f1)
		token_id=$(echo "$token_info" | cut -d' ' -f2)
	else
		log_error "No valid token received, skipping" "tool=$tool"
		echo "failed" >"$status_file"
		return 1
	fi

	local rate_limit_info
	rate_limit_info=$(GITHUB_TOKEN="$token" mise x -- wait-for-gh-rate-limit 2>&1 || echo "")
	local remaining
	remaining=$(echo "$rate_limit_info" | grep -oP 'GitHub rate limit: \K[0-9]+' || echo "5000")
	if [ "$remaining" -lt 1000 ]; then
		log_warn "GitHub rate limit low" "remaining=$remaining" "tool=$tool"
	fi
	log_info "Fetching versions" "tool=$tool"

	# Create a temporary file to capture stderr and check for rate limiting.
	# Docker container is used for isolation: `mise ls-remote` may execute
	# untrusted plugin code (asdf/vfox), and the sandbox contains it.
	local stderr_file
	stderr_file=$(mktemp)

	if ! docker run --rm -e GITHUB_TOKEN="$token" -e MISE_USE_VERSIONS_HOST -e MISE_LIST_ALL_VERSIONS -e MISE_LOG_HTTP -e MISE_EXPERIMENTAL -e MISE_TRUSTED_CONFIG_PATHS=/ \
		jdxcode/mise -y ls-remote "$tool" >"docs/$tool" 2>"$stderr_file"; then
		log_error "Failed to fetch versions" "tool=$tool"
		cat "$stderr_file" >&2

		if grep -q "403 Forbidden" "$stderr_file"; then
			local reset_time=""
			if [ "$remaining" == "0" ]; then
				reset_time=$(echo "$rate_limit_info" | grep -oP 'resets at \K\S+ \S+' || echo "")
			fi
			mark_token_rate_limited "$token_id" "$reset_time"
			rm -f "$stderr_file" "docs/$tool"

			# Cap retries so 8 parallel workers can't chain-exhaust the token
			# pool in milliseconds when everyone hits rate limits at once.
			if [ "$attempt" -lt "$FETCH_MAX_ATTEMPTS" ]; then
				log_warn "Rate limited, retrying with new token" "tool=$tool" "token_id=$token_id" "attempt=$attempt"
				sleep 1
				fetch "$tool" "$((attempt + 1))"
				return
			fi
			log_error "Rate limited, max retries reached" "tool=$tool" "attempts=$attempt"
			echo "failed" >"$status_file"
			return
		fi

		rm -f "$stderr_file" "docs/$tool"
		echo "failed" >"$status_file"
		return
	fi

	rm -f "$stderr_file"

	local new_lines
	new_lines=$(wc -l <"docs/$tool")
	if [ "$new_lines" -eq 0 ]; then
		log_debug "No versions found" "tool=$tool"
		rm -f "docs/$tool"
		echo "no_versions" >"$status_file"
		return
	fi

	# Tool-specific post-processing of the plain text file before TOML generation
	case "$tool" in
	cargo-binstall)
		mv docs/cargo-binstall{,.tmp}
		grep -E '^[0-9]' docs/cargo-binstall.tmp >docs/cargo-binstall
		rm docs/cargo-binstall.tmp
		;;
	java)
		sort -V "docs/$tool" -o "docs/$tool"
		;;
	vault | consul | nomad | terraform | packer | vagrant | boundary | protobuf)
		mv "docs/$tool"{,.tmp}
		grep -E '^[0-9]' "docs/$tool.tmp" >"docs/$tool"
		rm "docs/$tool.tmp"
		sort -V "docs/$tool" -o "docs/$tool"
		;;
	esac

	generate_toml_file "$tool" "$token"
	rm -f "docs/$tool"
	echo "fetched" >"$status_file"
}

# Wrapper used by xargs -P. Ensures a non-empty status file exists even if
# `fetch` times out or crashes, so the parent's aggregation sees every tool.
# The tool name is passed as a positional argument (not interpolated into the
# -c string) to avoid shell injection if a name ever contains quotes.
run_fetch() {
	local tool="$1"
	local status_file="$RESULTS_DIR/$tool.status"
	# The `$1` inside the single-quoted bash -c refers to the positional arg
	# after `--` (the tool name), not a variable in this shell.
	# shellcheck disable=SC2016
	if ! timeout 60s bash -c 'fetch "$1"' -- "$tool"; then
		log_error "Fetch timed out or failed" "tool=$tool"
	fi
	# If fetch exited without writing a status (timeout/SIGKILL), record it.
	[ -s "$status_file" ] || echo "failed" >"$status_file"
}

# Enhanced token management setup
setup_token_management() {
	log_group_start "Token Management Setup"

	if [ -z "$TOKEN_MANAGER_URL" ] || [ -z "$TOKEN_MANAGER_SECRET" ]; then
		log_error "Token manager not configured"
		log_group_end
		return 1
	fi

	# Check token manager health
	if ! curl -f -s "$TOKEN_MANAGER_URL/health" >/dev/null 2>&1; then
		log_error "Token manager health check failed" "url=$TOKEN_MANAGER_URL"
		log_group_end
		return 1
	fi
	log_info "Token manager health check passed"

	# Get token statistics
	if STATS=$(curl -s -H "Authorization: Bearer $TOKEN_MANAGER_SECRET" "$TOKEN_MANAGER_URL/api/stats" 2>/dev/null); then
		ACTIVE_TOKENS=$(echo "$STATS" | jq -r '.active // 0' 2>/dev/null || echo "0")
		log_info "Token pool status" "active_tokens=$ACTIVE_TOKENS"
		if [ "$ACTIVE_TOKENS" -eq 0 ]; then
			log_error "No active tokens available"
			log_group_end
			return 1
		fi
	fi

	log_group_end
}

# Setup token management before starting
if setup_token_management; then
	log_group_start "Initialization"

	CUR_MISE_VERSION=$(docker run jdxcode/mise -v)
	export CUR_MISE_VERSION
	log_info "Mise version detected" "version=$CUR_MISE_VERSION"

	tools="$(docker run -e MISE_EXPERIMENTAL=1 -e MISE_VERSION="$CUR_MISE_VERSION" jdxcode/mise registry | awk '{print $1}')"
	total_tools=$(echo "$tools" | wc -w)
	set_stat "total_tools_available" "$total_tools"
	log_info "Tool registry loaded" "total_tools=$total_tools"

	# Check if tokens are available before starting processing
	if ! get_github_token >/dev/null 2>&1; then
		log_warn "No tokens available - stopping early"
		log_group_end
		generate_summary
		exit 0
	fi

	log_group_end

	log_group_start "Processing Tools"

	# Cleanup old tools that are no longer in the registry
	log_info "Cleaning up old tools"
	for file in docs/*.toml; do
		if [[ ! -f "$file" ]]; then
			continue
		fi
		tool_name=$(basename "$file" .toml)
		# specialized files we want to keep around
		if [[ "$tool_name" == python-precompiled* ]]; then
			continue
		fi
		if ! echo "$tools" | grep -q "^$tool_name$"; then
			log_info "Removing old tool" "tool=$tool_name"
			rm -f "$file" "docs/$tool_name"
			git rm --ignore-unmatch "$file" "docs/$tool_name" 2>/dev/null || true
		fi
	done

	# Fetch all tools in parallel. Each worker writes a status file to
	# RESULTS_DIR; the parent aggregates counts and stages git changes afterward.
	RESULTS_DIR=$(mktemp -d -t mise_results.XXXXXX)
	export FETCH_MAX_ATTEMPTS
	export RESULTS_DIR

	# Pre-seed empty status files for every tool. If a worker is hard-killed
	# (SIGKILL/OOM) before it can write a status, the empty file is still
	# visible to the aggregator and counted as "failed" rather than silently
	# dropped from total_tools_checked.
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		: >"$RESULTS_DIR/$t.status"
	done <<<"$tools"

	PARALLEL_FETCHES="${PARALLEL_FETCHES:-8}"
	log_info "Fetching tools in parallel" "workers=$PARALLEL_FETCHES" "tools=$total_tools"

	export -f fetch run_fetch get_github_token mark_token_rate_limited generate_toml_file increment_stat get_stat add_to_list set_stat
	export -f log log_debug log_info log_warn log_error should_log log_timestamp get_log_priority
	export STATS_DIR LOG_LEVEL

	# xargs -P parallelizes across workers. `-d '\n'` splits on newlines only
	# (defensive against tool names with whitespace), `-r` skips on empty input,
	# `|| true` prevents xargs's non-zero exit when any worker fails from
	# killing the script under `set -e`. The `$0` inside the single-quoted
	# bash -c refers to the positional arg passed by xargs, not a variable
	# in this shell.
	# shellcheck disable=SC2016
	printf '%s\n' "$tools" | xargs -r -d '\n' -n 1 -P "$PARALLEL_FETCHES" bash -c 'run_fetch "$0"' || true

	log_group_end

	log_group_start "Aggregating Results"

	# Count status outcomes from worker output. Empty status files indicate
	# a worker was hard-killed before it could write a result; treat as failed.
	for status_file in "$RESULTS_DIR"/*.status; do
		[ -f "$status_file" ] || continue
		increment_stat "total_tools_checked"
		status=$(cat "$status_file")
		[ -n "$status" ] || status="failed"
		case "$status" in
		skipped) increment_stat "total_tools_skipped" ;;
		failed) increment_stat "total_tools_failed" ;;
		no_versions) increment_stat "total_tools_no_versions" ;;
		fetched) ;; # counted as updated below iff the TOML actually changed
		esac
	done

	# Stage all TOML changes at once, then determine which actually changed.
	# Git index mutation must be serialized — this runs after all workers finish.
	# We stage TOMLs only; any stray plain-text files are cleaned up by the
	# workflow's `git checkout docs && git clean -df docs` step.
	git add 'docs/*.toml' 2>/dev/null || true
	while IFS= read -r changed_file; do
		[ -n "$changed_file" ] || continue
		[[ "$changed_file" == *.toml ]] || continue
		tool=$(basename "$changed_file" .toml)
		add_to_list "$tool"
		increment_stat "total_tools_updated"
	done < <(git diff --cached --name-only -- 'docs/*.toml' 2>/dev/null)

	log_group_end

	if [ "${DRY_RUN:-}" == 0 ] && ! git diff-index --cached --quiet HEAD; then
		git diff --compact-summary --cached

		# Get the list of updated tools for the commit message (newline-separated
		# from concurrent appends — flatten to a space-separated string).
		updated_tools_list=$(cat "$STATS_DIR/updated_tools_list" 2>/dev/null | tr '\n' ' ' | sed -E 's/ +/ /g; s/^ //; s/ $//')
		tools_updated_count=$(get_stat "total_tools_updated")

		commit_msg=""
		if [ -n "$updated_tools_list" ] && [ "$tools_updated_count" -gt 0 ]; then
			# Create a more descriptive commit message with updated tools
			if [ "$tools_updated_count" -le 10 ]; then
				# If 10 or fewer tools, list them all
				commit_msg="versions: update $tools_updated_count tools ($updated_tools_list)"
			else
				# If more than 10 tools, just show the count
				commit_msg="versions: update $tools_updated_count tools"
			fi
		else
			# Fallback to original message
			commit_msg="versions: update"
		fi

		git commit -m "$commit_msg"
		# Push is deferred to the workflow so it only happens after D1 sync
		# succeeds, preventing orphaned commits when sync fails.
	fi

	# Save updated tools list for D1 sync (one tool per line)
	cat "$STATS_DIR/updated_tools_list" 2>/dev/null | tr ' ' '\n' | grep -v '^$' >updated_tools.txt || true
	updated_count=$(wc -l <updated_tools.txt | tr -d ' ')
	log_info "Updated tools saved" "file=updated_tools.txt" "count=$updated_count"
else
	log_error "Token management setup failed"
	generate_summary
	exit 0
fi

# Always generate and display summary
generate_summary

log_info "Update complete" "tools_checked=$(get_stat total_tools_checked)" "tools_updated=$(get_stat total_tools_updated)"
