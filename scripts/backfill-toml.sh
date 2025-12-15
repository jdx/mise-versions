#!/usr/bin/env bash
# Backfill TOML files for all tools that don't have them yet
# Uses current timestamp for all versions (no historical data available)

set -euo pipefail

cd "$(dirname "$0")/.."

count=0
total=$(ls docs/ | grep -v '\.' | wc -l | tr -d ' ')

for tool in docs/*; do
  # Skip files with extensions (like .toml, .json, .html)
  [[ "$tool" == *.* ]] && continue

  # Skip if not a file
  [[ ! -f "$tool" ]] && continue

  toolname=$(basename "$tool")

  # Skip special files (CNAME, etc)
  [[ "$toolname" == "CNAME" ]] && continue
  [[ "$toolname" =~ ^[A-Z] ]] && continue  # Skip uppercase files (likely special)

  toml_file="docs/${toolname}.toml"

  count=$((count + 1))

  # Skip if TOML already exists
  if [[ -f "$toml_file" ]]; then
    echo "[$count/$total] Skipping $toolname (TOML exists)"
    continue
  fi

  echo "[$count/$total] Generating $toolname.toml..."

  # Convert plain text versions to NDJSON and generate TOML
  while read -r v; do
    [ -n "$v" ] && echo "{\"version\":\"$v\"}"
  done < "$tool" | node scripts/generate-toml.js "$toolname" > "$toml_file"
done

echo "Done! Generated TOML files for tools without them."
