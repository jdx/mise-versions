#!/bin/bash
# Build script for Cloudflare Pages
# This combines the SPA build with the docs data

set -e

cd "$(dirname "$0")"

# Build the SPA
npm run build

# Copy docs data to dist/data
mkdir -p dist/data
cp ../docs/*.toml dist/data/ 2>/dev/null || true
cp ../docs/tools.json dist/data/ 2>/dev/null || true

# Create _redirects for SPA routing (handle client-side routes)
cat > dist/_redirects << 'EOF'
/* /index.html 200
EOF

echo "Build complete. Output in web/dist/"
