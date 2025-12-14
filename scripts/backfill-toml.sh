#!/usr/bin/env bash
# Backfill created_at timestamps in TOML files using mise ls-remote --json
#
# Usage: ./scripts/backfill-toml.sh [tool1 tool2 ...]
# If no tools specified, processes all TOML files in docs/

set -euo pipefail

DOCS_DIR="${DOCS_DIR:-docs}"

backfill_tool() {
    local tool="$1"
    local toml_file="$DOCS_DIR/$tool.toml"

    if [[ ! -f "$toml_file" ]]; then
        echo "Skipping $tool: no TOML file"
        return
    fi

    # Get versions with timestamps from mise
    local json
    if ! json=$(mise ls-remote "$tool" --json 2>/dev/null); then
        echo "Skipping $tool: mise ls-remote failed"
        return
    fi

    # Check if we got valid JSON with created_at
    if ! echo "$json" | jq -e '.[0].created_at' >/dev/null 2>&1; then
        echo "Skipping $tool: no created_at in response"
        return
    fi

    # Build lookup map file (version -> timestamp) for fast lookups
    local lookup_file=$(mktemp)
    echo "$json" | jq -r '.[] | select(.created_at) | "\(.version)\t\(.created_at)"' > "$lookup_file"

    # Create a temp file for the updated TOML
    local tmp_file=$(mktemp)

    # Process the TOML file, updating timestamps
    local updated=0
    while IFS= read -r line; do
        # Check if this is a version line with placeholder timestamp
        if [[ "$line" =~ ^\"([^\"]+)\"[[:space:]]*=[[:space:]]*\{[[:space:]]*created_at[[:space:]]*=[[:space:]]*2025-01-01 ]]; then
            local version="${BASH_REMATCH[1]}"
            # Look up the real timestamp from lookup file
            local real_ts
            real_ts=$(grep "^${version}	" "$lookup_file" 2>/dev/null | cut -f2 || true)
            if [[ -n "$real_ts" ]]; then
                echo "\"$version\" = { created_at = $real_ts }" >> "$tmp_file"
                updated=$((updated + 1))
            else
                echo "$line" >> "$tmp_file"
            fi
        else
            echo "$line" >> "$tmp_file"
        fi
    done < "$toml_file"

    rm -f "$lookup_file"

    if [[ $updated -gt 0 ]]; then
        mv "$tmp_file" "$toml_file"
        echo "Updated $tool: $updated timestamps"
    else
        rm "$tmp_file"
        echo "Skipping $tool: no updates needed"
    fi
}

# Get list of tools to process
if [[ $# -gt 0 ]]; then
    tools=("$@")
else
    tools=()
    for f in "$DOCS_DIR"/*.toml; do
        [[ -f "$f" ]] || continue
        tool=$(basename "$f" .toml)
        tools+=("$tool")
    done
fi

echo "Processing ${#tools[@]} tools..."
count=0
for tool in "${tools[@]}"; do
    backfill_tool "$tool"
    count=$((count + 1))
    if ((count % 50 == 0)); then
        echo "Progress: $count/${#tools[@]}"
    fi
done
echo "Done! Processed $count tools"
