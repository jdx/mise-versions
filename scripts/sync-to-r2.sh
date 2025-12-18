#!/usr/bin/env bash
# Sync docs/ directory to Cloudflare R2 bucket using s5cmd
# Requires: CLOUDFLARE_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY

set -euo pipefail

R2_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
BUCKET="mise-versions-data"

echo "Syncing docs/ to R2 bucket: $BUCKET"

s5cmd --endpoint-url "$R2_ENDPOINT" sync docs/ "s3://$BUCKET/tools/"

echo "Sync complete"
