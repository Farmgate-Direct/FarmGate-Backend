#!/usr/bin/env bash
# Build the Bulacan OSRM extract. Run ON the backend server.
# Records the Geofabrik file date -> use it as OSRM_DATA_VERSION.
set -euo pipefail

BBOX="120.5,14.4,121.4,15.4"   # left,bottom,right,top (matches BULACAN_BBOX)
WORKDIR="$(cd "$(dirname "$0")/data" && pwd)"
mkdir -p "$WORKDIR"
cd "$WORKDIR"

echo "== 1/4 download Philippines extract (Geofabrik)"
wget https://download.geofabrik.de/asia/philippines-latest.osm.pbf -O philippines.osm.pbf
echo "== extract file date (SET THIS as OSRM_DATA_VERSION):"
ls -l --time-style=long-iso philippines.osm.pbf

echo "== 2/4 crop to Bulacan bbox $BBOX"
osmium extract \
  --bbox "$BBOX" \
  --strategy complete_ways \
  philippines.osm.pbf \
  -o bulacan.osm.pbf

echo "== 3/4 osrm-extract (car profile)"
docker run --rm -v "$WORKDIR:/data" osrm/osrm-backend \
  osrm-extract -p /opt/car.lua /data/bulacan.osm.pbf

echo "== 4/4 partition + customize (MLD)"
docker run --rm -v "$WORKDIR:/data" osrm/osrm-backend \
  osrm-partition /data/bulacan.osrm
docker run --rm -v "$WORKDIR:/data" osrm/osrm-backend \
  osrm-customize /data/bulacan.osrm

echo "DONE. Serve with: docker compose up -d   (in farmgate-backend/osrm/)"
echo "Then: node scripts/osrm-healthcheck.js"
