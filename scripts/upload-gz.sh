#!/usr/bin/env bash
# Upload python-precompiled .gz files to R2 via API
# Requires: API_URL, API_SECRET environment variables

set -euo pipefail

GZ_DIR="${GZ_DIR:-/tmp/python-precompiled-gz}"
API_URL="${API_URL:-https://mise-versions.jdx.dev}"

if [ -z "${API_SECRET:-}" ]; then
	echo "Error: API_SECRET environment variable is required"
	exit 1
fi

if [ ! -d "$GZ_DIR" ]; then
	echo "Error: GZ_DIR does not exist: $GZ_DIR"
	exit 1
fi

uploaded=0
failed=0

for gz in "$GZ_DIR"/*.gz; do
	if [ ! -f "$gz" ]; then
		echo "No .gz files found in $GZ_DIR"
		exit 0
	fi

	filename=$(basename "$gz")
	echo "Uploading $filename..."

	# Base64 encode the file and write to temp file to avoid argument list too long
	tmpfile=$(mktemp)
	base64 <"$gz" | tr -d '\n' >"$tmpfile"

	# Create JSON payload file
	jsonfile=$(mktemp)
	printf '{"filename": "%s", "data": "' "$filename" >"$jsonfile"
	cat "$tmpfile" >>"$jsonfile"
	printf '"}' >>"$jsonfile"
	rm "$tmpfile"

	# Upload via API using file input
	response=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/api/admin/gz/upload" \
		-H "Authorization: Bearer $API_SECRET" \
		-H "Content-Type: application/json" \
		-d @"$jsonfile")

	rm "$jsonfile"

	# Extract HTTP status code (last line)
	http_code=$(echo "$response" | tail -n1)
	body=$(echo "$response" | sed '$d')

	if [ "$http_code" = "200" ]; then
		echo "  ✓ Uploaded $filename"
		uploaded=$((uploaded + 1))
	else
		echo "  ✗ Failed to upload $filename (HTTP $http_code): $body"
		failed=$((failed + 1))
	fi
done

echo ""
echo "Upload complete: $uploaded succeeded, $failed failed"

if [ "$failed" -gt 0 ]; then
	exit 1
fi
