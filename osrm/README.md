# OSRM — self-hosted road distance for Bulacan delivery fees

Free, no third-party calls, no Google APIs. One OSRM instance runs on the
existing backend server, bound to localhost. **Only the Express backend
(`osrmClient.js`) may call it — the mobile client never calls OSRM directly**
(coordinates never leave our infrastructure).

## Bounding box (Bulacan + small margin)

Must match `BULACAN_BBOX` in `deliveryFee.js` — pins outside it are rejected.

```
left (minLng)   = 120.5
bottom (minLat) = 14.4
right (maxLng)  = 121.4
top (maxLat)    = 15.4
```

## Rebuild the extract (run on the backend server)

Prerequisites: `osmium-tool`, docker (or a native `osrm-backend` build).

```bash
# 1. Philippines extract from Geofabrik (note the file date -> OSRM_DATA_VERSION)
wget https://download.geofabrik.de/asia/philippines-latest.osm.pbf -O philippines.osm.pbf
ls -l --time-style=long-iso philippines.osm.pbf   # <-- record this date

# ...or regenerate the helper script values:
# 2. Crop to Bulacan + margin
osmium extract \
  --bbox 120.5,14.4,121.4,15.4 \
  --strategy complete_ways \
  philippines.osm.pbf \
  -o bulacan.osm.pbf

# 3. Build the MLD routing graph (car profile)
docker run --rm -v "$PWD:/data" osrm/osrm-backend \
  osrm-extract -p /opt/car.lua /data/bulacan.osm.pbf
docker run --rm -v "$PWD:/data" osrm/osrm-backend \
  osrm-partition /data/bulacan.osrm
docker run --rm -v "$PWD:/data" osrm/osrm-backend \
  osrm-customize /data/bulacan.osrm
```

Same steps are in `osrm/build-extract.sh`.

## Run it

```bash
cd farmgate-backend/osrm
docker compose up -d        # binds 127.0.0.1:5000 only (not public)
docker compose logs -f osrm # wait for "running and waiting for requests"
node ../scripts/osrm-healthcheck.js
```

`osrm-routed` runs with `--algorithm mld` (matches the partition/customize
build above). The service restarts on failure (`restart: unless-stopped`).

## Health check

`node scripts/osrm-healthcheck.js` routes one known intra-Bulacan pair and
requires `code === "Ok"` plus a positive distance. Wire it to your monitor
(cron every 5 min is enough); non-zero exit = page.

## Env vars (backend)

| Var | Meaning |
|---|---|
| `OSRM_BASE_URL` | e.g. `http://127.0.0.1:5000`. Never a public third-party URL. |
| `OSRM_DATA_VERSION` | Extract date, e.g. `2026-10-01`. Part of the cache key and stamped on every order (`osrmDataVersion`) so records stay traceable. **Update on every rebuild.** |

## How often to update

- Rebuild **monthly** (Geofabrik refreshes daily; monthly is plenty for Bulacan roads), or sooner if a new road opens.
- After rebuilding: set the new `OSRM_DATA_VERSION`, restart `osrm-routed`, run the health check, then run `node scripts/calibrate-osrm.js` and eyeball the table. Old cache entries miss automatically (version is in the key); 30-day expiry cleans up the rest.

## Build resources

`osrm-extract` on the Bulacan crop needs roughly 2–4 GB RAM; MLD
`osrm-customize` peaks similarly. **Record the actual server RAM observed
during your build here:**

- Build date: ______________ (set at deploy time)
- Extract file date (`OSRM_DATA_VERSION`): ______________
- Peak RAM observed: ______________

## Files

- `osrm/docker-compose.yml` — the service (localhost bind, restart policy)
- `osrm/build-extract.sh` — extract → crop → extract/partition/customize
- `scripts/osrm-healthcheck.js` — `code === "Ok"` smoke test
- `scripts/calibrate-osrm.js` — OSRM-vs-Google calibration table helper
