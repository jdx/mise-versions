#!/usr/bin/env bash
# shellcheck disable=SC1091
source env_parallel.bash
set -euxo pipefail

export MISE_NODE_MIRROR_URL="https://nodejs.org/dist/"
export MISE_USE_VERSIONS_HOST=0
export MISE_LIST_ALL_VERSIONS=1
export MISE_LOG_HTTP=1

# GitHub Token Manager configuration
export TOKEN_MANAGER_URL="${TOKEN_MANAGER_URL:-}"
export TOKEN_MANAGER_SECRET="${TOKEN_MANAGER_SECRET:-}"

if [ "${DRY_RUN:-}" == 0 ]; then
	git config --local user.email "189793748+mise-en-versions@users.noreply.github.com"
	git config --local user.name "mise-en-versions"
fi

# Function to get a fresh GitHub token from the token manager
get_github_token() {
	if [ -z "$TOKEN_MANAGER_URL" ] || [ -z "$TOKEN_MANAGER_SECRET" ]; then
		echo "⚠️  TOKEN_MANAGER_URL and TOKEN_MANAGER_SECRET not set, falling back to GITHUB_API_TOKEN"
		echo "$GITHUB_API_TOKEN"
		return
	fi

	echo "🔄 Getting fresh GitHub token from token manager..."
	
	# Use the github-token.js script to get a token
	if ! TOKEN_RESPONSE=$(node scripts/github-token.js get-token 2>/dev/null); then
		echo "❌ Failed to get token from token manager, falling back to GITHUB_API_TOKEN"
		echo "$GITHUB_API_TOKEN"
		return
	fi
	
	# Extract token from the response (the script outputs it to stdout)
	if [ -n "$GITHUB_ACTIONS" ]; then
		# In GitHub Actions, the token is set as an output
		echo "✅ Token obtained from token manager"
		echo "$TOKEN_RESPONSE"
	else
		# For local runs, parse from script output or use fallback
		echo "$GITHUB_API_TOKEN"
	fi
}

# Function to record token usage for monitoring
record_token_usage() {
	local plugin_name="$1"
	local token_id="${2:-unknown}"
	
	if [ -z "$TOKEN_MANAGER_URL" ] || [ -z "$TOKEN_MANAGER_SECRET" ]; then
		return
	fi
	
	# Record usage asynchronously to not slow down the main process
	{
		node scripts/github-token.js record-usage \
			"$token_id" \
			"/repos/*/$plugin_name" \
			4800 \
			"$(date -d '+1 hour' +%s)" \
			2>/dev/null || true
	} &
}

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
	
	# Get a fresh token for this fetch operation
	MISE_GITHUB_TOKEN=$(get_github_token)
	export MISE_GITHUB_TOKEN
	
	mise x -- wait-for-gh-rate-limit || true
	echo "Fetching $1"
	if ! docker run -e MISE_GITHUB_TOKEN -e MISE_USE_VERSIONS_HOST -e MISE_LIST_ALL_VERSIONS -e MISE_LOG_HTTP -e MISE_EXPERIMENTAL -e MISE_TRUSTED_CONFIG_PATHS=/ \
		jdxcode/mise -y ls-remote "$1" >"docs/$1" 2> >(tee /dev/stderr | grep -q "403 Forbidden" && echo "403" >/tmp/mise_403); then
		echo "Failed to fetch versions for $1"
		rm -f "docs/$1"
		return
	fi

	# Record token usage for monitoring
	record_token_usage "$1" "unknown"

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

# Enhanced token management setup
setup_token_management() {
	echo "🔧 Setting up token management..."
	
	if [ -n "$TOKEN_MANAGER_URL" ] && [ -n "$TOKEN_MANAGER_SECRET" ]; then
		echo "✅ Using GitHub Token Manager at $TOKEN_MANAGER_URL"
		
		# Check token manager health
		if curl -f -s "$TOKEN_MANAGER_URL/health" >/dev/null 2>&1; then
			echo "✅ Token manager is healthy"
			
			# Get token statistics
			if STATS=$(curl -s -H "Authorization: Bearer $TOKEN_MANAGER_SECRET" "$TOKEN_MANAGER_URL/api/stats" 2>/dev/null); then
				ACTIVE_TOKENS=$(echo "$STATS" | jq -r '.active // 0' 2>/dev/null || echo "0")
				echo "📊 Available tokens: $ACTIVE_TOKENS"
				
				if [ "$ACTIVE_TOKENS" -eq 0 ]; then
					echo "⚠️  No active tokens available, falling back to GITHUB_API_TOKEN"
				fi
			fi
		else
			echo "⚠️  Token manager health check failed, falling back to GITHUB_API_TOKEN"
		fi
	else
		echo "⚠️  Token manager not configured, using GITHUB_API_TOKEN"
	fi
}

# Setup token management before starting
setup_token_management

docker run jdxcode/mise -v
tools="$(docker run -e MISE_EXPERIMENTAL=1 jdxcode/mise registry | awk '{print $1}')"

# Enhanced parallel processing with better token distribution
echo "🚀 Starting parallel fetch operations..."
echo "$tools" | sort -R | head -n 100 | env_parallel -j4 --env fetch fetch {} || true

# Clean up any background processes
wait

if [ "${DRY_RUN:-}" == 0 ] && ! git diff-index --cached --quiet HEAD; then
	git diff --compact-summary --cached
	git commit -m "versions"
	git pull --autostash --rebase origin main
	git push
fi

echo "✅ Update complete!"
