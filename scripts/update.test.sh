#!/usr/bin/env bash
# Tests for update.sh shell script logic
#
# Run with: bash scripts/update.test.sh
# Or: aube test (after adding to package.json)

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
