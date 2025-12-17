#!/bin/bash
# Build script for Cloudflare Pages (Astro SSR)

set -e

cd "$(dirname "$0")"

# Copy docs data to public/data for static serving
mkdir -p public/data
cp ../docs/*.toml public/data/ 2>/dev/null || true
cp ../docs/tools.json public/data/ 2>/dev/null || true

# Build the Astro app
npm run build

echo "Build complete. Output in web/dist/"
