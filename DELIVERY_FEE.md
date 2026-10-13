# Delivery Fee (Barangay-Centroid × Road Factor, Bulacan Only, No GPS)

Automatic delivery fees from city + barangay only. No external calls.

## Config (single point — `farmgate-backend/distance.js`)

| Key | Default | Notes |
|---|---|---|
| `ROAD_FACTOR` (`FARMGATE_ROAD_DISTANCE_FACTOR` env, fallback `FARMGATE_ROAD_FACTOR`) | 1.3 | Clamped 1–2, out-of-range → 1.3 |
| `FEE_TIERS` | 0–3 km ₱25 · 3.1–5 km ₱35 · 5.1–10 km ₱50 · 10.1–15 km ₱70 · 15.1–20 km ₱90 · 20.1–25 km ₱110 · 25.1–30 km ₱130 · 30.1–40 km ₱160 · 40.1–50 km ₱190 · 50.1–60 km ₱220 · 60.1–70 km ₱250 | Inclusive upper bounds on adjusted distance; over 70 km throws `TOO_FAR` (blocked) |
| `TIER_VERSION` | `barangay-1.3-v2` | Stamped on every order for audit |

Adjusted distance = haversine(barangay centroids) × factor, rounded to 0.1 km
BEFORE the tier lookup. Same barangay (exact normalized city + barangay
match) = 0 km, ₱25. No municipality-center fallback for new orders.

## Data (complete, required)

- `data/bulacan_barangays.csv` — 569/569 barangays (`city,barangay,lat,lng`).
- `data/build_barangay_data.js` — CSV → `data/bulacanBarangays.js`. FAILS on
  wrong row count, missing/out-of-bbox coords, or duplicate `(city,barangay)`
  keys. `npm run build:barangays` / `check:barangays` (`--check-only`).
- Frontend dropdown source: `client/mobile/constants/bulacanBarangays.ts`
  (names must match the backend exactly; exact match only, no fuzzy).

## Flow (preview-only quote, fixed at creation)

- Farmer picks City → Barangay in Farm Profile (`users/{id}`:
  `municipality`/`city` + `barangay`, province locked to Bulacan). Missing
  barangay → amber banner; delivery blocked (`FARM_MISSING_BARANGAY`).
- Buyer picks City → Barangay in address (`addresses/{id}`: `city`,
  `barangay`, `province`). Text kept for the courier, never geocoded.
- Checkout calls `POST /delivery/quote` once for all farms (batch preview);
  server reads each farm barangay from `users/{farmerId}`.
- `POST /orders` creates the order with the server-computed fee (client fee
  ignored — enforced by `firestore.rules`, which forbid clients from writing
  fee fields).
- `/accept` (COD) and `/create-payment` (GCash) use the STORED fee as-is —
  no recompute. Products are still re-priced from server data; post-pay
  values are immutable (`/deliver` untouched and idempotent).
- Old orders without barangay keep their written fee (`legacy`, no recompute).

## Error codes

`INVALID_PROVINCE` · `UNKNOWN_CITY` · `UNKNOWN_BARANGAY` ·
`BARANGAY_NOT_SERVICEABLE` · `FARM_MISSING_BARANGAY` ·
`ADDRESS_MISSING_BARANGAY` · `INVALID_DISTANCE`

## Calibration note (San Isidro → Iba, Hagonoy)

Centroids are ~1.89 km apart → ×1.3 = **2.46 km → ₱25**, while Google driving
says **~6.1 km** (river-delta detour via Palapat). The ×1.3 factor
underestimates pairs split by rivers/highways. If Hagonoy-style detours
dominate real orders, raise `FARMGATE_ROAD_DISTANCE_FACTOR` (e.g. 1.5–2.0) —
but that overprices compact routes, so compare the 5 samples below against
Google Maps before changing it.

## Tests

Backend: `node --test __tests__/distance.test.js __tests__/deliveryFee.test.js __tests__/deliveryService.test.js __tests__/pinValidation.test.js __tests__/backend.test.js`
App tier mirror: `node --test utils/__tests__/deliveryFee.test.ts` (from `client/mobile`)
