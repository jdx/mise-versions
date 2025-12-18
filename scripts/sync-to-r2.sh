#!/usr/bin/env bash
# Sync docs/ directory to Cloudflare R2 bucket
# Uses wrangler CLI - requires CLOUDFLARE_API_TOKEN environment variable

set -euo pipefail

BUCKET_NAME="mise-versions-data"
DOCS_DIR="docs"
PARALLEL_JOBS="${PARALLEL_JOBS:-20}"

upload_file() {
  local file="$1"
  local key="${file#docs/}"

  # Determine content type based on extension
  local content_type
  case "$file" in
    *.json) content_type="application/json" ;;
    *.toml) content_type="application/toml" ;;
    *.txt)  content_type="text/plain" ;;
    *.png)  content_type="image/png" ;;
    *)      content_type="application/octet-stream" ;;
  esac

  if npx wrangler r2 object put "$BUCKET_NAME/$key" --file "$file" --content-type "$content_type" > /dev/null 2>&1; then
    echo "✓ $key"
  else
    echo "✗ $key" >&2
  fi
}
export -f upload_file
export BUCKET_NAME

if [[ ! -d "$DOCS_DIR" ]]; then
  echo "Error: $DOCS_DIR directory not found"
  exit 1
fi

if ! command -v npx &> /dev/null; then
  echo "Error: npx not found"
  exit 1
fi

total_files=$(find "$DOCS_DIR" -type f | wc -l | tr -d ' ')
echo "Syncing $total_files files to R2 bucket: $BUCKET_NAME (${PARALLEL_JOBS} parallel jobs)"

find "$DOCS_DIR" -type f | xargs -P "$PARALLEL_JOBS" -I {} bash -c 'upload_file "$@"' _ {}

echo "Sync complete"
