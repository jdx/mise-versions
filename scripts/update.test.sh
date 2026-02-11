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
# Test: Newline escaping in resumption logic
# ============================================
echo "--- Newline Escaping Tests ---"

# Test the grep pattern with $'\n' works correctly
test_newline_resumption() {
	local tools="tool1
tool2
tool3
tool4
tool5"

	# This is the pattern from update.sh (simplified)
	local last_tool="tool2"

	# Using $'\n' for actual newline (the fix from PR #37)
	local result
	result=$(grep -m 1 -A 100 -F -x "$last_tool" <<<"$tools"$'\n'"$tools" | tail -n +2 | head -n 3)

	# Should return tool3, tool4, tool5 (after tool2)
	local expected="tool3
tool4
tool5"

	assert_equals "$expected" "$result" "Newline resumption with \$'\\n' returns correct tools"
}
test_newline_resumption

# Test that wrong escaping would fail
test_wrong_newline_escaping() {
	local tools="tool1
tool2
tool3"

	local last_tool="tool2"

	# Wrong way (literal \n in double quotes - this is what was broken)
	# Note: we're testing that the CORRECT way works, not recreating the bug
	local result
	result=$(grep -m 1 -A 100 -F -x "$last_tool" <<<"$tools"$'\n'"$tools" | tail -n +2 | head -n 1)

	assert_equals "tool3" "$result" "Correct escaping finds tool after last processed"
}
test_wrong_newline_escaping

# Test resumption from first tool
test_resumption_from_first() {
	local tools="alpha
beta
gamma"

	local last_tool="alpha"
	local result
	result=$(grep -m 1 -A 100 -F -x "$last_tool" <<<"$tools"$'\n'"$tools" | tail -n +2 | head -n 2)

	local expected="beta
gamma"

	assert_equals "$expected" "$result" "Resumption from first tool returns remaining tools"
}
test_resumption_from_first

# Test resumption when tool not found (starts from beginning)
test_resumption_not_found() {
	local tools="alpha
beta
gamma"

	local last_tool="nonexistent"
	local result
	# When grep fails (tool not found), fall back to first 100 tools
	result=$(grep -m 1 -A 100 -F -x "$last_tool" <<<"$tools"$'\n'"$tools" | tail -n +2 || echo "$tools" | head -n 100)

	# Should get all tools since nonexistent wasn't found
	assert_contains "$result" "alpha" "Resumption with nonexistent tool includes first tool"
}
test_resumption_not_found

# Test resumption wraps around
test_resumption_wraparound() {
	local tools="tool1
tool2
tool3"

	local last_tool="tool3"
	local result
	result=$(grep -m 1 -A 100 -F -x "$last_tool" <<<"$tools"$'\n'"$tools" | tail -n +2 | head -n 3)

	# After tool3, it should wrap to tool1, tool2, tool3
	local expected="tool1
tool2
tool3"

	assert_equals "$expected" "$result" "Resumption from last tool wraps to beginning"
}
test_resumption_wraparound

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

# Test increment_stat function
test_increment_stat() {
	local stats_dir="$TEMP_DIR/stats"
	mkdir -p "$stats_dir"
	echo "0" >"$stats_dir/counter"

	# Simulate increment_stat
	increment_test() {
		local stat_file="$stats_dir/counter"
		local current_value
		current_value=$(cat "$stat_file" 2>/dev/null || echo "0")
		echo $((current_value + 1)) >"$stat_file"
	}

	increment_test
	increment_test
	increment_test

	local result
	result=$(cat "$stats_dir/counter")

	assert_equals "3" "$result" "increment_stat increments correctly"
}
test_increment_stat

# Test add_to_list function
test_add_to_list() {
	local stats_dir="$TEMP_DIR/stats2"
	mkdir -p "$stats_dir"
	echo "" >"$stats_dir/list"

	# Simulate add_to_list
	add_to_list_test() {
		local list_file="$stats_dir/list"
		local tool="$1"
		local current_list
		current_list=$(cat "$list_file" 2>/dev/null || echo "")
		if [ -n "$current_list" ]; then
			echo "$current_list $tool" >"$list_file"
		else
			echo "$tool" >"$list_file"
		fi
	}

	add_to_list_test "node"
	add_to_list_test "python"
	add_to_list_test "go"

	local result
	result=$(cat "$stats_dir/list")

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
