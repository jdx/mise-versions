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
	echo "$value" > "$stat_file"
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
	
	# Create summary file
	cat > summary.md << SUMMARY_EOF
# 📊 Mise Versions Update Summary

**Generated**: $(date '+%Y-%m-%d %H:%M:%S UTC')

## 📊 Quick Stats
| Metric | Value |
|--------|-------|
| Tools Processed | $(get_stat "total_tools_checked") |
| Tools Updated | $(get_stat "total_tools_updated") |
| Success Rate | $([ "$(get_stat "total_tools_checked")" -gt 0 ] && echo "$(( ($(get_stat "total_tools_updated") * 100) / $(get_stat "total_tools_checked") ))" || echo "0")% |
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
- **Success Rate**: $([ "$(get_stat "total_tools_checked")" -gt 0 ] && echo "$(( ($(get_stat "total_tools_updated") * 100) / $(get_stat "total_tools_checked") ))" || echo "0")%
- **Update Rate**: $([ "$(get_stat "total_tools_checked")" -gt 0 ] && echo "$(( ($(get_stat "total_tools_updated") * 100) / $(get_stat "total_tools_checked") ))" || echo "0")%
- **Coverage**: $([ "$(get_stat "total_tools_available")" -gt 0 ] && echo "$(( ($(get_stat "total_tools_checked") * 100) / $(get_stat "total_tools_available") ))" || echo "0")%

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

## 📊 Performance Metrics
- **Processing Speed**: $([ "$duration" -gt 0 ] && [ "$((duration / 60))" -gt 0 ] && echo "$(( $(get_stat "total_tools_checked") / (duration / 60) ))" || echo "0") tools/minute
- **Update Speed**: $([ "$duration" -gt 0 ] && [ "$((duration / 60))" -gt 0 ] && echo "$(( $(get_stat "total_tools_updated") / (duration / 60) ))" || echo "0") updates/minute
- **Token Efficiency**: $([ "$(get_stat "total_tokens_used")" -gt 0 ] && echo "$(( $(get_stat "total_tools_checked") / $(get_stat "total_tokens_used") ))" || echo "0") tools per token

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
			echo "- [$tool](docs/$tool)" >> summary.md
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

# Function to mark a token as rate-limited
mark_token_rate_limited() {
	local token_id="$1"
	local reset_time="${2:-}"
	
	if [ -z "$TOKEN_MANAGER_URL" ] || [ -z "$TOKEN_MANAGER_SECRET" ]; then
		return
	fi
	
	echo "🚫 Marking token $token_id as rate-limited" >&2
	increment_stat "total_rate_limits_hit"
	
	# Mark token as rate-limited asynchronously
	{
		if [ -n "$reset_time" ]; then
			node scripts/github-token.js mark-rate-limited "$token_id" "$reset_time" || true
		else
			node scripts/github-token.js mark-rate-limited "$token_id" || true
		fi
	} &
}

# Function to get a fresh GitHub token from the token manager
get_github_token() {
	if [ -z "$TOKEN_MANAGER_URL" ] || [ -z "$TOKEN_MANAGER_SECRET" ]; then
		echo "❌ TOKEN_MANAGER_URL and TOKEN_MANAGER_SECRET not set, stopping processing" >&2
		return 1
	fi

	echo "🔄 Getting fresh GitHub token from token manager..." >&2
	increment_stat "total_tokens_used"
	
	# Use the github-token.js script to get a token
	# Capture both stdout (token) and stderr (includes token_id)
	local token_output
	if ! token_output=$(node scripts/github-token.js get-token); then
		echo "❌ Failed to get token from token manager - no more tokens available" >&2
		echo "🛑 Stopping processing as no tokens are available" >&2
		return 1
	fi
	
	# Extract token (last line of output) and token_id (from stderr)
	local token
	local token_id
	
	token=$(echo "$token_output" | cut -d' ' -f1)
	token_id=$(echo "$token_output" | cut -d' ' -f2)
	
	echo "✅ Token obtained from token manager (ID: $token_id)" >&2
	echo "$token $token_id"
	
	return 0
}


fetch() {
	increment_stat "total_tools_checked"
	
	case "$1" in
	awscli-local) # TODO: remove this when it is working
		echo "Skipping $1"
		increment_stat "total_tools_skipped"
		return
		;;
	jfrog-cli | minio | tiny | teleport-ent | flyctl | flyway | vim | awscli | aws | aws-cli | checkov | snyk | chromedriver | sui | rebar)
		echo "Skipping $1"
		increment_stat "total_tools_skipped"
		return
		;;
	esac
	
	# Get a fresh token for this fetch operation
	local token_info
	if ! token_info=$(get_github_token); then
		# No tokens available, stop processing this tool gracefully
		echo "🛑 No tokens available for $1, skipping..."
		increment_stat "total_tools_failed"
		return 1
	fi
	local token
	local token_id
	
	# Parse token and token_id from the response
	if [[ "$token_info" == *" "* ]]; then
		token=$(echo "$token_info" | cut -d' ' -f1)
		token_id=$(echo "$token_info" | cut -d' ' -f2)
	else
		# No valid token received, stop processing this tool
		echo "❌ No valid token received for $1, skipping..."
		increment_stat "total_tools_failed"
		return 1
	fi
	
	GITHUB_TOKEN="$token" mise x -- wait-for-gh-rate-limit || true
	echo "Fetching $1 (using token ID: $token_id)"
	
	# Create a temporary file to capture stderr and check for rate limiting
	local stderr_file
	stderr_file=$(mktemp)
	
	if ! docker run -e GITHUB_TOKEN="$token" -e MISE_USE_VERSIONS_HOST -e MISE_LIST_ALL_VERSIONS -e MISE_LOG_HTTP -e MISE_EXPERIMENTAL -e MISE_TRUSTED_CONFIG_PATHS=/ \
		jdxcode/mise -y ls-remote "$1" >"docs/$1" 2>"$stderr_file"; then
		echo "Failed to fetch versions for $1"
		increment_stat "total_tools_failed"
		
		# Check if this was a rate limit issue (403 Forbidden)
		if grep -q "403 Forbidden" "$stderr_file"; then
			echo "⚠️  Rate limit hit for token $token_id on $1, marking token as rate-limited" >&2
			
			# Extract rate limit reset time from response headers if available
			local reset_time
			reset_time=$(grep -i "x-ratelimit-reset" "$stderr_file" | cut -d: -f2 | tr -d ' ' || echo "")
			
			# Mark this specific token as rate-limited
			mark_token_rate_limited "$token_id" "$reset_time"
			
			echo "🔄 Will try with a different token next time" >&2
		else
			# Show the actual error for non-rate-limit failures
			cat "$stderr_file" >&2
		fi
		
		rm -f "$stderr_file" "docs/$1"
		return
	fi
	
	# Clean up stderr file
	rm -f "$stderr_file"

	new_lines=$(wc -l <"docs/$1")
	if [ ! "$new_lines" -gt 1 ]; then
		echo "No versions for $1" >/dev/null
		increment_stat "total_tools_no_versions"
		rm -f "docs/$1"
	else
		increment_stat "total_tools_updated"
		add_to_list "$1"
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

# Enhanced token management setup
setup_token_management() {
	echo "🔧 Setting up token management..." >&2
	
	if [ -n "$TOKEN_MANAGER_URL" ] && [ -n "$TOKEN_MANAGER_SECRET" ]; then
		echo "✅ Using GitHub Token Manager at $TOKEN_MANAGER_URL" >&2
		
		# Check token manager health
		if curl -f -s "$TOKEN_MANAGER_URL/health" >/dev/null 2>&1; then
			echo "✅ Token manager is healthy" >&2
			
			# Get token statistics
			if STATS=$(curl -s -H "Authorization: Bearer $TOKEN_MANAGER_SECRET" "$TOKEN_MANAGER_URL/api/stats" 2>/dev/null); then
				ACTIVE_TOKENS=$(echo "$STATS" | jq -r '.active // 0' 2>/dev/null || echo "0")
				echo "📊 Available tokens: $ACTIVE_TOKENS" >&2
				
				if [ "$ACTIVE_TOKENS" -eq 0 ]; then
					echo "❌ No active tokens available, stopping processing" >&2
					return 1
				fi
			fi
		else
			echo "❌ Token manager health check failed, stopping processing" >&2
			return 1
		fi
	else
		echo "❌ Token manager not configured, stopping processing" >&2
		return 1
	fi
}

# Setup token management before starting
if setup_token_management; then
	CUR_MISE_VERSION=$(docker run jdxcode/mise -v)
	export CUR_MISE_VERSION

	tools="$(docker run -e MISE_EXPERIMENTAL=1 -e MISE_VERSION="$CUR_MISE_VERSION" jdxcode/mise registry | awk '{print $1}')"
	set_stat "total_tools_available" "$(echo "$tools" | wc -w)"

	# Check if tokens are available before starting processing
	echo "🔍 Checking token availability before starting..."
	if ! get_github_token >/dev/null; then
		echo "🛑 No tokens available - stopping all processing"
		generate_summary
		exit 0
	fi

	# Enhanced parallel processing with better token distribution
	echo "🚀 Starting parallel fetch operations..."
	# Prevent broken pipe error by collecting tools first
	tools_limited=$(echo "$tools" | shuf -n 100)
	export -f fetch get_github_token mark_token_rate_limited increment_stat get_stat add_to_list set_stat
	export STATS_DIR
	for tool in $tools_limited; do
		if ! timeout 60s bash -c "fetch $tool"; then
			echo "❌ Failed to fetch $tool, stopping processing"
			break
		fi
	done

	if [ "${DRY_RUN:-}" == 0 ] && ! git diff-index --cached --quiet HEAD; then
		git diff --compact-summary --cached
		git commit -m "versions"
		git pull --autostash --rebase origin main
		git push
	fi
else
	echo "❌ Token management setup failed"
	generate_summary
	exit 0
fi

# Always generate and display summary
generate_summary

echo "✅ Update complete!"
