#!/usr/bin/env bash
# Tests for update.sh shell script logic
#
# Run with: bash scripts/update.test.sh
# Or: npm test (after adding to package.json)

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0

# Test helper functions
pass() {
	echo -e "${GREEN}✓${NC} $1"
	PASSED=$((PASSED + 1))
}

fail() {
	echo -e "${RED}✗${NC} $1"
	echo "  Expected: $2"
	echo "  Got: $3"
	FAILED=$((FAILED + 1))
}

assert_equals() {
	local expected="$1"
	local actual="$2"
	local description="$3"

	if [ "$expected" = "$actual" ]; then
		pass "$description"
	else
		fail "$description" "$expected" "$actual"
	fi
}

assert_contains() {
	local haystack="$1"
	local needle="$2"
	local description="$3"

	if [[ "$haystack" == *"$needle"* ]]; then
		pass "$description"
	else
		fail "$description" "string containing '$needle'" "$haystack"
	fi
}

# Create temp directory for tests
TEMP_DIR=$(mktemp -d)
# shellcheck disable=SC2329
cleanup() {
	rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "=== Shell Script Tests for update.sh ==="
echo ""

# ============================================
# Test: NDJSON piping via stdin
# ============================================
echo "--- NDJSON Stdin Piping Tests ---"

# Test that while read loop produces valid NDJSON
test_ndjson_generation() {
	local versions_file="$TEMP_DIR/test_versions"
	echo -e "1.0.0\n2.0.0\n3.0.0" >"$versions_file"

	local result
	result=$(while read -r version || [ -n "$version" ]; do
		if [ -n "$version" ]; then
			jq -c -n --arg v "$version" '{"version": $v}'
		fi
	done <"$versions_file")

	# Should produce valid NDJSON (compact, one per line)
	assert_contains "$result" '{"version":"1.0.0"}' "NDJSON contains version 1.0.0"
	assert_contains "$result" '{"version":"2.0.0"}' "NDJSON contains version 2.0.0"
	assert_contains "$result" '{"version":"3.0.0"}' "NDJSON contains version 3.0.0"
}
test_ndjson_generation

# Test empty version lines are skipped
test_ndjson_skips_empty() {
	local versions_file="$TEMP_DIR/test_versions_empty"
	printf "1.0.0\n\n2.0.0\n\n" >"$versions_file"

	local count
	count=$(while read -r version || [ -n "$version" ]; do
		if [ -n "$version" ]; then
			echo "x"
		fi
	done <"$versions_file" | wc -l | tr -d ' ')

	assert_equals "2" "$count" "Empty lines are skipped in NDJSON generation"
}
test_ndjson_skips_empty

# Test special characters in versions
test_ndjson_special_chars() {
	local versions_file="$TEMP_DIR/test_versions_special"
	echo -e "v1.0.0-beta.1\ntemurin-21.0.1+12\n2024.01.15" >"$versions_file"

	local result
	result=$(while read -r version || [ -n "$version" ]; do
		if [ -n "$version" ]; then
			jq -c -n --arg v "$version" '{"version": $v}'
		fi
	done <"$versions_file")

	# Verify jq properly escapes special characters
	assert_contains "$result" '"version":"v1.0.0-beta.1"' "NDJSON handles dash and dot"
	assert_contains "$result" '"version":"temurin-21.0.1+12"' "NDJSON handles plus sign"
}
test_ndjson_special_chars

# Test piping to generate-toml.js works
test_pipe_to_generate_toml() {
	local versions_file="$TEMP_DIR/test_versions_pipe"
	echo -e "1.0.0\n2.0.0" >"$versions_file"

	local toml_output
	toml_output=$(while read -r version || [ -n "$version" ]; do
		if [ -n "$version" ]; then
			jq -c -n --arg v "$version" '{"version": $v}'
		fi
	done <"$versions_file" | node scripts/generate-toml.js test-tool 2>/dev/null)

	assert_contains "$toml_output" "[versions]" "Piped output produces valid TOML structure"
	assert_contains "$toml_output" '"1.0.0"' "Piped output contains version 1.0.0"
	assert_contains "$toml_output" '"2.0.0"' "Piped output contains version 2.0.0"
}
test_pipe_to_generate_toml

echo ""

# ============================================
# Test: update skip list
# ============================================
echo "--- Skip List Tests ---"

skip_list_contains() {
	local tool="$1"
	local skipped_tools
	skipped_tools=$(awk '
		/^fetch\(\) \{/ { in_fetch = 1; next }
		in_fetch && /case "\$tool" in/ { getline; print; exit }
	' scripts/update.sh |
		tr '|' '\n' |
		sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s/\)$//' |
		grep -v '^$')

	grep -Fxq "$tool" <<<"$skipped_tools"
}

assert_skip_list_membership() {
	local tool="$1"
	local expected="$2"
	local description="$3"
	local actual="false"
	if skip_list_contains "$tool"; then
		actual="true"
	fi

	assert_equals "$expected" "$actual" "$description"
}

test_phase_2_unskips_stable_tools() {
	local tool
	for tool in awscli-local jfrog-cli minio teleport-ent flyctl flyway checkov snyk rebar dasel cockroach; do
		assert_skip_list_membership "$tool" "false" "$tool is no longer hard-skipped"
	done
}
test_phase_2_unskips_stable_tools

test_phase_2_keeps_unresolved_tools_skipped() {
	local tool
	for tool in tiny vim aws aws-cli awscli chromedriver sui; do
		assert_skip_list_membership "$tool" "true" "$tool remains hard-skipped"
	done
}
test_phase_2_keeps_unresolved_tools_skipped

test_skip_list_parser_ignores_other_case_blocks() {
	assert_skip_list_membership "cargo-binstall" "false" "cargo-binstall post-processing is not treated as hard-skipped"
}
test_skip_list_parser_ignores_other_case_blocks

echo ""

# ============================================
# Test: version collection disables release age filtering
# ============================================
echo "--- Version Collection Release Age Tests ---"

test_json_collection_disables_release_age_filtering() {
	local collection_function
	collection_function=$(sed -n '/^docker_ls_remote() {/,/^}/p' scripts/update.sh)

	assert_contains "$collection_function" 'ls-remote --minimum-release-age 0s "$@" "$tool"' \
		"Every listing disables minimum_release_age"
}
test_json_collection_disables_release_age_filtering

test_json_collection_requires_upstream_metadata() {
	local command
	command=$(grep -F -A 1 'docker_ls_remote "$tool" "$token" "$stderr_file" "$json_file"' scripts/update.sh)

	assert_contains "$command" '--json' \
		"Catalog collection uses the JSON metadata listing"
	assert_contains "$command" '--prerelease' \
		"Catalog collection gathers the prerelease superset"
	assert_contains "$command" '--no-versions-host' \
		"JSON metadata collection explicitly bypasses the versions host"
	assert_contains "$command" '--strict-metadata' \
		"JSON metadata collection fails when upstream metadata fails"
}
test_json_collection_requires_upstream_metadata

test_every_listing_runs_in_the_docker_sandbox() {
	# Drop comments and plain literal-string assignments (log/reason text that
	# merely names the command) so only real invocations are counted; an
	# assignment capturing a command substitution still counts.
	local invocations
	invocations=$(grep -vE '^[[:space:]]*#' scripts/update.sh |
		grep -vE '^[[:space:]]*[a-z_]+="[^$`]*"[[:space:]]*$' |
		grep -c 'ls-remote')

	assert_equals "1" "$invocations" \
		"ls-remote is only ever invoked through the Docker sandbox helper"
}
test_every_listing_runs_in_the_docker_sandbox

test_new_versions_are_rejected_during_metadata_fallback() {
	local fallback_block
	fallback_block=$(sed -n '/fallback_new_versions=$(collect_fallback_new_versions/,/if jq -R -c/p' scripts/update.sh)

	assert_contains "$fallback_block" 'if [ -n "$fallback_new_versions" ]; then' \
		"Metadata fallback detects newly discovered versions"
	assert_contains "$fallback_block" 'Refusing to add new versions without metadata' \
		"Metadata fallback rejects incomplete new versions"
	assert_contains "$fallback_block" 'return 1' \
		"Metadata fallback fails the tool update"
}
test_new_versions_are_rejected_during_metadata_fallback

test_fallback_new_versions_ignore_denied_tags() {
	local test_root="$TEMP_DIR/fallback_versions"
	local collect_function
	local yq_bin
	collect_function=$(sed -n '/^collect_fallback_new_versions() {/,/^}/p' scripts/update.sh)
	yq_bin=$(mise which yq 2>/dev/null || command -v yq)
	mkdir -p "$test_root/docs"
	ln -s "$PWD/scripts" "$test_root/scripts"
	printf '1.0.0\nnightly\n' >"$test_root/docs/crush"
	printf '[versions]\n"1.0.0" = { created_at = 2026-01-01T00:00:00.000Z }\n' >"$test_root/docs/crush.toml"

	local result
	result=$(
		cd "$test_root"
		PATH="$(dirname "$yq_bin"):$PATH"
		eval "$collect_function"
		collect_fallback_new_versions crush
	)
	assert_equals "" "$result" "Ignored tags do not block metadata fallback"

	printf '1.0.0\n2.0.0\nnightly\n' >"$test_root/docs/crush"
	result=$(
		cd "$test_root"
		PATH="$(dirname "$yq_bin"):$PATH"
		eval "$collect_function"
		collect_fallback_new_versions crush
	)
	assert_equals "2.0.0" "$result" "Fallback comparison still reports real new versions"
}
test_fallback_new_versions_ignore_denied_tags

test_generate_toml_missing_versions_file_fails() {
	local missing_file_block
	missing_file_block=$(sed -n '/Versions file disappeared before TOML generation/,/fi/p' scripts/update.sh)

	assert_contains "$missing_file_block" 'return 1' \
		"Missing versions files fail TOML generation"
}
test_generate_toml_missing_versions_file_fails

test_json_generation_errors_are_reported() {
	local json_function
	json_function=$(sed -n '/^generate_toml_from_json() {/,/^}/p' scripts/update.sh)

	assert_contains "$json_function" 'cat "$error_output" >&2' \
		"JSON-to-TOML generation errors are printed before fallback"
}
test_json_generation_errors_are_reported

# `fetch` used to make two full upstream listings per tool: a plain-text one for
# a file it discarded on the happy path, then the JSON one that actually
# produces the TOML. On repos with very large `/releases` responses (openai/codex,
# ggml-org/llama.cpp) two listings exceeded the 60s per-tool timeout and the tool
# stopped being updated at all. jdx/mise#12543
run_fetch_with_stubbed_listings() {
	local json_body="$1"
	local json_exit="${2:-0}"
	local test_root="$TEMP_DIR/fetch_listings"

	rm -rf "$test_root"
	mkdir -p "$test_root/docs" "$test_root/results"

	(
		cd "$test_root"
		set +e
		# Read by the `fetch` body eval'd in below, not by this function.
		# shellcheck disable=SC2034
		RESULTS_DIR="$test_root/results"
		# shellcheck disable=SC2034
		FETCH_MAX_ATTEMPTS=3
		NEEDS_PLAIN_TEXT_FALLBACK=2
		# shellcheck disable=SC2329
		get_github_token() { echo "tok tok-id"; }
		# shellcheck disable=SC2329
		mise() { echo "GitHub rate limit: 5000"; }
		# shellcheck disable=SC2329
		log_info() { :; }
		# shellcheck disable=SC2329
		log_warn() { :; }
		# shellcheck disable=SC2329
		log_debug() { :; }
		# shellcheck disable=SC2329
		log_error() { :; }
		# shellcheck disable=SC2329
		increment_stat() { :; }
		# shellcheck disable=SC2329
		add_to_list() { :; }
		# shellcheck disable=SC2329
		docker_ls_remote() {
			echo "call" >>"$test_root/listing_calls"
			if [[ " $* " == *" --json "* ]]; then
				printf '%s' "$json_body" >"$4"
				: >"$3"
				return "$json_exit"
			fi
			printf '1.0.0\n' >"$4"
		}
		# shellcheck disable=SC2329
		generate_toml_from_json() {
			[ -s "$2" ] && [ "$(jq -r 'length' "$2")" -gt 0 ] && return 0
			# shellcheck disable=SC2034
			json_metadata_fallback_reason="empty JSON metadata array"
			return "$NEEDS_PLAIN_TEXT_FALLBACK"
		}
		# shellcheck disable=SC2329
		generate_toml_from_plain_text() { return 0; }

		eval "$FETCH_FUNCTION"
		fetch tool-under-test >/dev/null 2>&1

		printf '%s %s\n' \
			"$(wc -l <"$test_root/listing_calls" 2>/dev/null || echo 0)" \
			"$(cat "$test_root/results/tool-under-test.status")"
	)
}

test_successful_json_listing_skips_the_plain_text_listing() {
	FETCH_FUNCTION=$(sed -n '/^fetch() {/,/^}/p' scripts/update.sh)
	export FETCH_FUNCTION

	assert_equals "1 fetched" "$(run_fetch_with_stubbed_listings '[{"version":"1.0.0"}]')" \
		"A usable JSON listing costs exactly one upstream listing"
}
test_successful_json_listing_skips_the_plain_text_listing

test_unusable_json_listing_falls_back_to_the_plain_text_listing() {
	FETCH_FUNCTION=$(sed -n '/^fetch() {/,/^}/p' scripts/update.sh)
	export FETCH_FUNCTION

	assert_equals "2 fetched" "$(run_fetch_with_stubbed_listings '[]')" \
		"An unusable JSON listing still collects the plain-text listing"
}
test_unusable_json_listing_falls_back_to_the_plain_text_listing

# A tool whose metadata listing fails outright (e.g. --strict-metadata rejecting
# an incomplete upstream response) must still reach the plain-text fallback,
# which keeps stored metadata and refuses metadata-poor new versions. Failing
# the tool outright would leave its catalog stale — the bug this PR fixes.
test_failed_json_listing_still_falls_back() {
	FETCH_FUNCTION=$(sed -n '/^fetch() {/,/^}/p' scripts/update.sh)
	export FETCH_FUNCTION

	assert_equals "2 fetched" "$(run_fetch_with_stubbed_listings '' 1)" \
		"A failed JSON listing falls back instead of failing the tool"
}
test_failed_json_listing_still_falls_back

test_metadata_fallback_is_counted_once() {
	local increments
	increments=$(grep -c 'increment_stat "total_json_metadata_fallbacks"' scripts/update.sh)

	assert_equals "1" "$increments" \
		"A tool taking the metadata fallback is counted once per run"
}
test_metadata_fallback_is_counted_once

# Workers run `fetch` in a fresh `bash -c`, so every function it reaches has to
# be in the `export -f` list. A name in that list that is no longer a function
# is worse than a missing one: `export -f` fails, and under `set -e` that kills
# the whole updater before a single tool is fetched.
update_sh_defined_functions() {
	grep -oE '^[a-z_]+\(\) \{' scripts/update.sh | sed 's/() {$//' | sort -u
}

update_sh_exported_functions() {
	grep -E '^\s*export -f ' scripts/update.sh | sed -E 's/^\s*export -f //' | tr ' ' '\n' | sed '/^$/d' | sort -u
}

# Body of $1 with comments and the `local` declarations stripped, so a function
# name that only appears in prose is not mistaken for a call.
update_sh_function_body() {
	sed -n "/^$1() {/,/^}/p" scripts/update.sh | sed -E 's/(^|[[:space:]])#.*$//'
}

test_exported_functions_all_exist() {
	local missing=""
	local fn
	while IFS= read -r fn; do
		if ! update_sh_defined_functions | grep -qx "$fn"; then
			missing="$missing $fn"
		fi
	done < <(update_sh_exported_functions)

	assert_equals "" "$missing" "Every exported function name is a defined function"
}
test_exported_functions_all_exist

test_worker_reachable_functions_are_exported() {
	local defined exported
	defined=$(update_sh_defined_functions)
	exported=$(update_sh_exported_functions)

	# Breadth-first walk of the call graph from the worker entry point.
	local seen="run_fetch"
	local queue="run_fetch"
	local current body callee
	while [ -n "$queue" ]; do
		current=$(printf '%s\n' "$queue" | head -1)
		queue=$(printf '%s\n' "$queue" | tail -n +2)
		body=$(update_sh_function_body "$current")
		while IFS= read -r callee; do
			[ -n "$callee" ] || continue
			printf '%s\n' "$seen" | grep -qx "$callee" && continue
			printf '%s\n' "$body" | grep -qE "(^|[^[:alnum:]_\"])$callee([[:space:]]|$)" || continue
			seen="$seen"$'\n'"$callee"
			queue="$queue"$'\n'"$callee"
		done < <(printf '%s\n' "$defined")
	done

	local unexported=""
	while IFS= read -r callee; do
		[ -n "$callee" ] || continue
		printf '%s\n' "$exported" | grep -qx "$callee" || unexported="$unexported $callee"
	done < <(printf '%s\n' "$seen" | sort -u)

	assert_equals "" "$unexported" "Every function a worker can reach is exported"
}
test_worker_reachable_functions_are_exported

test_fallback_constant_is_exported() {
	assert_contains "$(grep -E '^\s*export NEEDS_PLAIN_TEXT_FALLBACK' scripts/update.sh)" \
		"export NEEDS_PLAIN_TEXT_FALLBACK" \
		"The fallback status constant reaches workers"
}
test_fallback_constant_is_exported

echo ""

# ============================================
# Test: Statistics helpers (isolated)
# ============================================
echo "--- Statistics Helper Tests ---"

# Test atomic increment via byte append (matches update.sh's increment_stat).
# Appending a single byte is atomic on POSIX, letting parallel workers share
# the same counter file without locks.
test_increment_stat_atomic() {
	local stats_dir="$TEMP_DIR/stats"
	mkdir -p "$stats_dir"
	: >"$stats_dir/counter"

	increment_test() {
		printf '.' >>"$stats_dir/counter"
	}

	increment_test
	increment_test
	increment_test

	local result
	result=$(wc -c <"$stats_dir/counter" | tr -d ' ')

	assert_equals "3" "$result" "increment_stat increments correctly"
}
test_increment_stat_atomic

# Stress the counter concurrently to confirm we don't lose increments.
test_increment_stat_parallel() {
	local stats_dir="$TEMP_DIR/stats_parallel"
	mkdir -p "$stats_dir"
	local counter_file="$stats_dir/counter"
	: >"$counter_file"

	for _ in $(seq 1 50); do
		(printf '.' >>"$counter_file") &
	done
	wait

	local result
	result=$(wc -c <"$counter_file" | tr -d ' ')

	assert_equals "50" "$result" "increment_stat loses no increments under concurrency"
}
test_increment_stat_parallel

# Test atomic append-style add_to_list (matches update.sh).
# Short-line appends fit within PIPE_BUF and are atomic on POSIX.
test_add_to_list() {
	local stats_dir="$TEMP_DIR/stats2"
	mkdir -p "$stats_dir"
	: >"$stats_dir/list"

	add_to_list_test() {
		echo "$1" >>"$stats_dir/list"
	}

	add_to_list_test "node"
	add_to_list_test "python"
	add_to_list_test "go"

	local result
	result=$(tr '\n' ' ' <"$stats_dir/list" | sed -E 's/ +$//')

	assert_equals "node python go" "$result" "add_to_list appends tools correctly"
}
test_add_to_list

echo ""

# ============================================
# Summary
# ============================================
echo "=== Test Summary ==="
echo -e "Passed: ${GREEN}${PASSED}${NC}"
echo -e "Failed: ${RED}${FAILED}${NC}"
echo ""

if [ "$FAILED" -gt 0 ]; then
	echo -e "${RED}Some tests failed!${NC}"
	exit 1
else
	echo -e "${GREEN}All tests passed!${NC}"
	exit 0
fi
