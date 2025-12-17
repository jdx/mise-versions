#!/usr/bin/env bash
# Backfill TOML files for tools that don't have them or have placeholder timestamps
# Uses current timestamp for versions without real timestamps

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

  # Skip if TOML already exists and has no placeholder timestamps
  if [[ -f "$toml_file" ]]; then
    if ! grep -q '2025-01-01T00:00:00.000Z' "$toml_file"; then
      echo "[$count/$total] Skipping $toolname (TOML exists, no placeholders)"
      continue
    fi
    echo "[$count/$total] Regenerating $toolname.toml (has placeholder timestamps)..."
  else
    echo "[$count/$total] Generating $toolname.toml..."
  fi

  # Convert plain text versions to NDJSON and generate TOML
  # Pass existing TOML path to preserve non-placeholder timestamps
  while read -r v; do
    [ -n "$v" ] && echo "{\"version\":\"$v\"}"
  done < "$tool" | node scripts/generate-toml.js "$toolname" "$toml_file" > "$toml_file.tmp" && mv "$toml_file.tmp" "$toml_file"
done

echo "Done! Generated TOML files for tools without them."
