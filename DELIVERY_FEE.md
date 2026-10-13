# Delivery Fee (Haversine × Road Factor)

Automatic delivery fees from straight-line distance × `ROAD_FACTOR`.
No external routing calls. No OSRM (removed).

## Config (single point — `farmgate-backend/distance.js`)

| Key | Default | Notes |
|---|---|---|
| `ROAD_FACTOR` (`FARMGATE_ROAD_FACTOR` env) | 1.3 | Clamped 1–2, out-of-range → 1.3 |
| `FEE_TIERS` | 0–3 km ₱30 · >3–7 km ₱50 · >7–12 km ₱75 · >12–20 km ₱100 · >20–30 km ₱130 · >30–40 km ₱160 · >40–50 km ₱190 · >50–60 km ₱220 · >60–70 km ₱250 | Inclusive upper bounds on adjusted distance |
| `MAX_AUTO_KM` | 20 | Over this → `needs_manual_fee`, fee null, never auto-priced |
| `TIER_VERSION` | `haversine-1.3-v1` | Stamped on every order for audit |

Adjusted distance is rounded to 0.1 km BEFORE the tier lookup.

## Flow

- Farmer sets pickup in Farm Profile (map pin, GPS, or barangay auto-suggest) → `users/{id}.pickupLocation { lat, lng, address }` (+ `farmLat`/`farmLng` mirror).
- Buyer sets delivery pin in address (map pin, GPS, or auto-suggest) → `addresses/{id} { lat, lng }`.
- Checkout calls `POST /delivery/quote` once for all farms (batch) or `POST /wallet/delivery/quote`.
- `POST /orders` creates the order and writes the server-computed fee (client fee ignored).
- `/accept` (COD) and `/create-payment` (GCash) recompute from tx-fresh reads; post-pay values are immutable.
- `>20 km`: `feeStatus: "needs_manual_fee"`, `deliveryFee: null`. Buyer sees "farmer confirms fee"; payment/accept stay blocked (`MANUAL_FEE_REQUIRED`) until the farmer sets it via `POST /orders/:id/delivery-fee`.
- Old orders without pins keep their written fee (`legacy`).

## Future routing provider

`getRoadDistance()` in `distance.js` is the marked extension point (memoized,
keyed by rounded coordinate pair + road factor). Swap its body for an
OpenRouteService call; `computeDeliveryFee()` and all callers stay unchanged.

## Tests

- Backend: `node --test __tests__/distance.test.js __tests__/deliveryFee.test.js __tests__/deliveryService.test.js __tests__/pinValidation.test.js __tests__/backend.test.js`
- App tier mirror: `node --test utils/__tests__/deliveryFee.test.ts` (from `client/mobile`)
