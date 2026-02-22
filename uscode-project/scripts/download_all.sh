#!/usr/bin/env bash
# Download and parse all titles of the United States Code.
#
# Usage:
#   bash scripts/download_all.sh [release-point]
#
# The release point defaults to 119-73not60 (Public Law 119-73, Jan 2026).
# To list available release points see:
#   https://uscode.house.gov/download/download.shtml
#
# Output goes to:
#   /tmp/uscode-data/   (intermediate: per-title toc-N.json + tN.json)
#   public/data/toc.json
#   public/data/t<N>.json  (one per title)
#   src/data/toc.json  (same, imported at build time)

set -euo pipefail

RELEASE="${1:-119-73not60}"
BASE_URL="https://uscode.house.gov/download/releasepoints/us/pl/${RELEASE/not/-}/xml"
# The URL uses the format pl/119/73not60 for release 119-73not60
# Reconstruct properly:
PL_PART=$(echo "$RELEASE" | sed 's/\([0-9]*\)-\([0-9]*\).*/\1\/\2/')
BASE_URL="https://uscode.house.gov/download/releasepoints/us/pl/${PL_PART}/${RELEASE}"

WORK_DIR="/tmp/uscode-data-${RELEASE}"
mkdir -p "$WORK_DIR"

# All title numbers (53 is reserved/omitted in official downloads)
TITLES="1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45 46 47 48 49 50 51 52 54"

echo "=== Downloading US Code titles (release: $RELEASE) ==="
echo "Work dir: $WORK_DIR"
echo ""

for N in $TITLES; do
    PADDED=$(printf "%02d" "$N")
    ZIP_URL="${BASE_URL}/xml_usc${PADDED}@${RELEASE}.zip"
    ZIP_PATH="$WORK_DIR/usc${PADDED}.zip"
    XML_PATH="$WORK_DIR/usc${PADDED}.xml"

    if [ -f "$XML_PATH" ]; then
        echo "  [skip] Title $N already extracted"
    else
        echo "  Downloading Title $N..."
        curl -sSL \
            -H "User-Agent: Mozilla/5.0" \
            -H "Referer: https://uscode.house.gov/download/download.shtml" \
            "$ZIP_URL" -o "$ZIP_PATH" || { echo "  WARN: Title $N download failed, skipping"; continue; }
        unzip -q -o "$ZIP_PATH" -d "$WORK_DIR" || { echo "  WARN: Title $N unzip failed, skipping"; continue; }
        # Rename extracted file if needed
        EXTRACTED=$(find "$WORK_DIR" -maxdepth 1 -name "usc${PADDED}.xml" | head -1)
        if [ -z "$EXTRACTED" ]; then
            echo "  WARN: Could not find usc${PADDED}.xml after unzip"
            continue
        fi
    fi

    echo "  Parsing Title $N..."
    python3 scripts/parse_xml.py "$XML_PATH" "$WORK_DIR" || { echo "  WARN: Parse failed for Title $N"; continue; }

    # Copy section data to public/data/
    cp "$WORK_DIR/t${N}.json" "public/data/t${N}.json" 2>/dev/null || true
done

echo ""
echo "=== Building combined TOC ==="
python3 scripts/build_toc.py "$WORK_DIR" public/data/toc.json "$RELEASE"

# Copy toc to src/data/ for build-time import
mkdir -p src/data
cp public/data/toc.json src/data/toc.json

echo ""
echo "=== Done ==="
echo "Run: npm run build"
