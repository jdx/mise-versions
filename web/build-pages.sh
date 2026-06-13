#!/bin/bash
# Build Astro in SSR mode (output: "server", @astrojs/cloudflare) for Workers:
# a Worker script for server-side routes plus static client assets under web/dist/.

set -e

cd "$(dirname "$0")"

# Build the Astro app
aube run build

echo "Build complete. Output in web/dist/"
