#!/usr/bin/env bash
# shellcheck disable=SC2129
set -euo pipefail

export MISE_NODE_MIRROR_URL="https://nodejs.org/dist/"
export MISE_USE_VERSIONS_HOST=0
export MISE_LIST_ALL_VERSIONS=1
export MISE_LOG_HTTP=1

# GitHub Proxy configuration
if [ -n "${GITHUB_PROXY_URL:-}" ] && [ -n "${API_SECRET:-}" ]; then
	export MISE_URL_REPLACEMENTS="{\"regex:^https://api\\.github\\.com\": \"${GITHUB_PROXY_URL}/gh\"}"
	# Pass API_SECRET as MISE_GITHUB_TOKEN for proxy authentication
	export MISE_GITHUB_TOKEN="$API_SECRET"
fi

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
		INFO)  echo 1 ;;
		WARN)  echo 2 ;;
		ERROR) echo 3 ;;
		*)     echo 1 ;;
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
			ERROR) color="\033[0;31m" ;;  # Red
			WARN)  color="\033[0;33m" ;;  # Yellow
			INFO)  color="\033[0;32m" ;;  # Green
			DEBUG) color="\033[0;36m" ;;  # Cyan
		esac
		echo -e "${color}[$timestamp] [$level]${reset} $message$context" >&2
	fi
}

# Convenience functions
log_debug() { log DEBUG "$@"; }
log_info()  { log INFO "$@"; }
log_warn()  { log WARN "$@"; }
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

# Initialize statistics files
echo "0" > "$STATS_DIR/total_tools_checked"
echo "0" > "$STATS_DIR/total_tools_updated"
echo "0" > "$STATS_DIR/total_tools_skipped"
echo "0" > "$STATS_DIR/total_tools_failed"
echo "0" > "$STATS_DIR/total_tools_no_versions"
echo "0" > "$STATS_DIR/total_tokens_used"
echo "0" > "$STATS_DIR/total_rate_limits_hit"
echo "0" > "$STATS_DIR/total_tools_available"
echo "" > "$STATS_DIR/updated_tools_list"
echo "" > "$STATS_DIR/first_processed_tool"
echo "" > "$STATS_DIR/last_processed_tool"
echo "false" > "$STATS_DIR/summary_generated"
START_TIME=$(date +%s)
echo "$START_TIME" > "$STATS_DIR/start_time"

# Helper functions for statistics
increment_stat() {
	local stat_file="$STATS_DIR/$1"
	local current_value
	current_value=$(cat "$stat_file" 2>/dev/null || echo "0")
	echo $((current_value + 1)) > "$stat_file"
}

get_stat() {
	local stat_file="$STATS_DIR/$1"
	cat "$stat_file" 2>/dev/null || echo "0"
}

add_to_list() {
	local list_file="$STATS_DIR/updated_tools_list"
	local tool="$1"
	local current_list
	current_list=$(cat "$list_file" 2>/dev/null || echo "")
	if [ -n "$current_list" ]; then
		echo "$current_list $tool" > "$list_file"
	else
		echo "$tool" > "$list_file"
	fi
}

set_stat() {
	local stat_file="$STATS_DIR/$1"
	local value="$2"
	# Silently fail if stats directory was cleaned up
	[ -d "$STATS_DIR" ] && echo "$value" > "$stat_file" || true
}

# Cleanup function
cleanup_stats() {
	rm -rf "$STATS_DIR"
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

	local end_time=$(date +%s)
	local duration=$((end_time - START_TIME))
	local duration_minutes=$((duration / 60))
	local duration_seconds=$((duration % 60))
	local commit_hash=$(git rev-parse HEAD 2>/dev/null || echo "main")

	# Create summary file
	cat > summary.md << SUMMARY_EOF
# 📊 Mise Versions Update Summary

**Generated**: $(date '+%Y-%m-%d %H:%M:%S UTC')
**Commit**: [${commit_hash}](https://github.com/jdx/mise-versions/commit/${commit_hash})

## 📊 Quick Stats
| Metric | Value |
|--------|-------|
| Tools Processed | $(get_stat "total_tools_checked") |
| Tools Updated | $(get_stat "total_tools_updated") |
| Success Rate | $([ "$(get_stat "total_tools_checked")" -gt 0 ] && echo "$(( ($(get_stat "total_tools_updated") * 100) / $(get_stat "total_tools_checked") ))" || echo "0")% |
| Duration | ${duration_minutes}m ${duration_seconds}s |

## 🎯 Overview
- **Total Tools Checked**: $(get_stat "total_tools_checked")
- **Tools Updated**: $(get_stat "total_tools_updated")
- **Tools Skipped**: $(get_stat "total_tools_skipped")
- **Tools Failed**: $(get_stat "total_tools_failed")
- **Tools with No Versions**: $(get_stat "total_tools_no_versions")
- **Duration**: ${duration_minutes}m ${duration_seconds}s
- **Mise Version**: ${CUR_MISE_VERSION:-not set}

## 📈 Success Rate
- **Success Rate**: $([ "$(get_stat "total_tools_checked")" -gt 0 ] && echo "$(( ($(get_stat "total_tools_updated") * 100) / $(get_stat "total_tools_checked") ))" || echo "0")%
- **Update Rate**: $([ "$(get_stat "total_tools_checked")" -gt 0 ] && echo "$(( ($(get_stat "total_tools_updated") * 100) / $(get_stat "total_tools_checked") ))" || echo "0")%
- **Coverage**: $([ "$(get_stat "total_tools_available")" -gt 0 ] && echo "$(( ($(get_stat "total_tools_checked") * 100) / $(get_stat "total_tools_available") ))" || echo "0")%

## 📋 Details
- **Tools Available**: $(get_stat "total_tools_available")
- **Tools Processed**: $(get_stat "total_tools_checked")
- **Tools with Updates**: $(get_stat "total_tools_updated")
- **Tools Skipped**: $(get_stat "total_tools_skipped")
- **Tools Failed**: $(get_stat "total_tools_failed")
- **Tools with No Versions**: $(get_stat "total_tools_no_versions")
- **Total Duration**: ${duration_minutes}m ${duration_seconds}s
- **First Tool Processed**: $(get_stat "first_processed_tool")
- **Last Tool Processed**: $(get_stat "last_processed_tool")

## 📊 Performance Metrics
- **Processing Speed**: $([ "$duration" -gt 0 ] && [ "$((duration / 60))" -gt 0 ] && echo "$(( $(get_stat "total_tools_checked") / (duration / 60) ))" || echo "0") tools/minute
- **Update Speed**: $([ "$duration" -gt 0 ] && [ "$((duration / 60))" -gt 0 ] && echo "$(( $(get_stat "total_tools_updated") / (duration / 60) ))" || echo "0") updates/minute

## 📦 Updated Tools ($(get_stat "total_tools_updated"))
SUMMARY_EOF

	# Add updated tools list if any tools were updated
	local updated_tools_list
	updated_tools_list=$(cat "$STATS_DIR/updated_tools_list" 2>/dev/null || echo "")
	if [ -n "$updated_tools_list" ]; then
		echo "" >> summary.md
		echo "The following tools were updated:" >> summary.md
		echo "" >> summary.md
		for tool in $updated_tools_list; do
			# Link to the local docs file
			echo "- [$tool](https://github.com/jdx/mise-versions/blob/${commit_hash}/docs/${tool}.toml)" >> summary.md
		done
	else
		echo "" >> summary.md
		echo "No tools were updated in this run." >> summary.md
	fi

	# Output to GitHub Actions summary
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		cat summary.md >> "$GITHUB_STEP_SUMMARY"
	fi

	echo "📊 Summary generated:"
	cat summary.md
	set_stat "summary_generated" "true"
}

# Function to generate TOML file with timestamps
generate_toml_file() {
	local tool="$1"
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
		' | node scripts/generate-toml.js "$tool" "$toml_file" > "$toml_file.tmp" 2>"$error_output"; then
			mv "$toml_file.tmp" "$toml_file"
			git add "$toml_file"
			rm -f "$error_output"
			return
		fi
	fi

	# Fall back to plain text conversion (preserves existing timestamps)
	if node -e '
		const fs = require("fs");
		const versions = fs.readFileSync(process.argv[1], "utf-8").trim().split("\n").filter(v => v);
		versions.forEach(v => console.log(JSON.stringify({version: v})));
	' "$versions_file" | node scripts/generate-toml.js "$tool" "$toml_file" > "$toml_file.tmp" 2>"$error_output"; then
		mv "$toml_file.tmp" "$toml_file"
		git add "$toml_file"
		rm -f "$error_output"
	else
		echo "Warning: Failed to generate TOML for $tool" >&2
		if [ -s "$error_output" ]; then
			cat "$error_output" >&2
		fi
		rm -f "$toml_file.tmp" "$error_output"
	fi
}

fetch() {
	increment_stat "total_tools_checked"

	case "$1" in
	awscli-local | jfrog-cli | minio | tiny | teleport-ent | flyctl | flyway | vim | awscli | aws | aws-cli | checkov | snyk | chromedriver | sui | rebar | dasel | cockroach)
		increment_stat "total_tools_skipped"
		return
		;;
	esac

	# Log removed to reduce verbosity
	# log_info "Fetching versions" "tool=$1"

	if ! docker run -e MISE_URL_REPLACEMENTS -e MISE_GITHUB_TOKEN -e MISE_USE_VERSIONS_HOST -e MISE_LIST_ALL_VERSIONS -e MISE_LOG_HTTP -e MISE_EXPERIMENTAL -e MISE_TRUSTED_CONFIG_PATHS=/ \
		jdxcode/mise -y ls-remote "$1" >"docs/$1"; then
		log_error "Failed to fetch versions" "tool=$1"
		increment_stat "total_tools_failed"
		rm -f "docs/$1"
		return
	fi

	new_lines=$(wc -l <"docs/$1")
	if [ "$new_lines" -eq 0 ]; then
		log_debug "No versions found" "tool=$1"
		increment_stat "total_tools_no_versions"
		rm -f "docs/$1"
	else
		# Process plain text file (used as intermediate for TOML generation)
		case "$1" in
		cargo-binstall)
			mv docs/cargo-binstall{,.tmp}
			grep -E '^[0-9]' docs/cargo-binstall.tmp >docs/cargo-binstall
			rm docs/cargo-binstall.tmp
			;;
		java)
			sort -V "docs/$1" -o "docs/$1"
			;;
		vault | consul | nomad | terraform | packer | vagrant | boundary | protobuf)
			mv "docs/$1"{,.tmp}
			grep -E '^[0-9]' "docs/$1.tmp" >"docs/$1"
			rm "docs/$1.tmp"
			sort -V "docs/$1" -o "docs/$1"
			;;
		esac

		# Generate TOML file with timestamps (only TOML is committed)
		generate_toml_file "$1"

		# Clean up intermediate plain text file
		rm -f "docs/$1"

		# Only count as updated if the TOML file actually changed (is staged)
		if git diff --cached --quiet -- "docs/$1.toml" 2>/dev/null; then
			:
		else
			increment_stat "total_tools_updated"
			add_to_list "$1"
		fi
	fi
}

CUR_MISE_VERSION=$(docker run jdxcode/mise -v)
export CUR_MISE_VERSION
log_info "Mise version detected" "version=$CUR_MISE_VERSION"

tools="$(docker run -e MISE_EXPERIMENTAL=1 -e MISE_VERSION="$CUR_MISE_VERSION" jdxcode/mise registry | awk '{print $1}')"
total_tools=$(echo "$tools" | wc -w)
set_stat "total_tools_available" "$total_tools"
log_info "Tool registry loaded" "total_tools=$total_tools"

# Resume from the last processed tool
last_tool_processed=""
if [ -f "last_processed_tool.txt" ]; then
	last_tool_processed=$(cat "last_processed_tool.txt")
	log_info "Resuming from previous run" "last_tool=$last_tool_processed"
fi
tools_limited=$(grep -m 1 -A 100 -F -x "$last_tool_processed" <<< "$tools"$'\n'"$tools" | tail -n +2 || echo "$tools" | head -n 100)

log_group_start "Processing Tools"

# Process tools
export -f fetch generate_toml_file increment_stat get_stat add_to_list set_stat
export -f log log_debug log_info log_warn log_error should_log log_timestamp get_log_priority
export STATS_DIR LOG_LEVEL
export MISE_URL_REPLACEMENTS
export MISE_GITHUB_TOKEN

first_processed_tool=""
last_processed_tool=""
processed_count=0

for tool in $tools_limited; do
	# Log progress every 10 tools
	processed_count=$((processed_count + 1))
	if (( processed_count % 10 == 0 )); then
		log_info "Processing tools..." "count=$processed_count"
	fi

	if ! timeout 60s bash -c "fetch $tool"; then
		log_error "Fetch timed out or failed, continuing" "tool=$tool"
		# Don't break, continue to next tool
		continue
	fi
	if [ -z "$first_processed_tool" ]; then
		first_processed_tool="$tool"
	fi
	last_processed_tool="$tool"
done

log_group_end
set_stat "first_processed_tool" "$first_processed_tool"
if [ -n "$last_processed_tool" ]; then
	echo "$last_processed_tool" >"last_processed_tool.txt"
fi
set_stat "last_processed_tool" "$last_processed_tool"

if [ "${DRY_RUN:-}" == 0 ] && ! git diff-index --cached --quiet HEAD; then
	git diff --compact-summary --cached

	# Get the list of updated tools for the commit message
	updated_tools_list=$(cat "$STATS_DIR/updated_tools_list" 2>/dev/null || echo "")
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
	git pull --autostash --rebase origin main
	git push
fi

# Save updated tools list for D1 sync (one tool per line)
cat "$STATS_DIR/updated_tools_list" 2>/dev/null | tr ' ' '\n' | grep -v '^$' > updated_tools.txt || true
updated_count=$(wc -l < updated_tools.txt | tr -d ' ')
log_info "Updated tools saved" "file=updated_tools.txt" "count=$updated_count"

# Always generate and display summary
generate_summary

log_info "Update complete" "tools_checked=$(get_stat total_tools_checked)" "tools_updated=$(get_stat total_tools_updated)"
