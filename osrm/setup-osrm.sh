#!/usr/bin/env bash
# ==============================================================================
# setup-osrm.sh - OnyaScoot OSRM Data Pre-processor
# ==============================================================================
# Downloads the Victoria OpenStreetMap road network and processes the routing
# graph using Docker and the OSRM car profile.
#
# Requirements:
#   - Docker running on the host (Mac, Linux, or Raspberry Pi)
#   - ~500 MB free disk space in ./osrm-data
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${SCRIPT_DIR}/../osrm-data"
OSM_FILE="victoria-latest.osm.pbf"
OSM_URL="https://download.geofabrik.de/australia-oceania/australia/${OSM_FILE}"

echo "==========================================================="
echo "   OnyaScoot OSRM Setup - Victoria Road Network"
echo "==========================================================="

mkdir -p "${DATA_DIR}"
cd "${DATA_DIR}"

# 1. Download OpenStreetMap extract if not present
if [ ! -f "${OSM_FILE}" ]; then
    echo "==> Downloading Victoria OSM extract (~140MB)..."
    curl -fSL -o "${OSM_FILE}" "${OSM_URL}"
else
    echo "==> Existing ${OSM_FILE} found, skipping download."
fi

# 2. Extract road network graph
echo "==> Extracting road network (osrm-extract)..."
docker run --rm -t -v "${DATA_DIR}:/data" osrm/osrm-backend:latest \
    osrm-extract -p /opt/car.lua "/data/${OSM_FILE}"

# 3. Partition network into multi-level cells (MLD)
echo "==> Partitioning road network (osrm-partition)..."
docker run --rm -t -v "${DATA_DIR}:/data" osrm/osrm-backend:latest \
    osrm-partition "/data/victoria-latest.osrm"

# 4. Customize cell weights and speeds (osrm-customize)
echo "==> Customizing weights (osrm-customize)..."
docker run --rm -t -v "${DATA_DIR}:/data" osrm/osrm-backend:latest \
    osrm-customize "/data/victoria-latest.osrm"

echo "==========================================================="
echo "   OSRM Data Preprocessing Complete!"
echo "==========================================================="
echo "You can now run: docker compose up -d osrm"
echo "Data directory: ${DATA_DIR}"
