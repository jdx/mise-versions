#!/usr/bin/env bash
# Sync docs/ directory to Cloudflare R2 bucket
# Uses wrangler CLI - requires CLOUDFLARE_API_TOKEN environment variable

set -euo pipefail

BUCKET_NAME="mise-versions-data"
DOCS_DIR="docs"

if [[ ! -d "$DOCS_DIR" ]]; then
  echo "Error: $DOCS_DIR directory not found"
  exit 1
fi

# Check if wrangler is available
if ! command -v npx &> /dev/null; then
  echo "Error: npx not found"
  exit 1
fi

# Count files for progress reporting
total_files=$(find "$DOCS_DIR" -type f | wc -l | tr -d ' ')
current=0

echo "Syncing $total_files files to R2 bucket: $BUCKET_NAME"

# Iterate through all files in docs/
find "$DOCS_DIR" -type f | while read -r file; do
  current=$((current + 1))

  # Get the relative path (without docs/ prefix) for R2 key
  key="${file#$DOCS_DIR/}"

  # Determine content type based on extension
  case "$file" in
    *.json) content_type="application/json" ;;
    *.toml) content_type="application/toml" ;;
    *.txt)  content_type="text/plain" ;;
    *.png)  content_type="image/png" ;;
    *)      content_type="application/octet-stream" ;;
  esac

  # Upload to R2
  if npx wrangler r2 object put "$BUCKET_NAME/$key" --file "$file" --content-type "$content_type" > /dev/null 2>&1; then
    echo "[$current/$total_files] Uploaded: $key"
  else
    echo "[$current/$total_files] Failed: $key"
  fi
done

echo "Sync complete"
