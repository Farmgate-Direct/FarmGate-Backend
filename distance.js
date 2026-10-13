// FarmGate delivery distance — barangay-centroid Haversine × road factor.
//
// Single config point for delivery pricing (change values here, not logic):
//   ROAD_FACTOR  (env FARMGATE_ROAD_DISTANCE_FACTOR, fallback
//                 FARMGATE_ROAD_FACTOR; default 1.3, clamped 1–2)
//   FEE_TIERS    (inclusive upper bounds on the ADJUSTED distance)
//   TIER_VERSION (stamped on every order for auditability)
//
// Distance comes ONLY from city + barangay (no GPS, no municipality-center
// fallback). Same barangay on both sides = 0 km. Otherwise: haversine
// between the two barangay centroids × ROAD_FACTOR, rounded to 0.1 km,
// then the tier lookup below. No external API calls.
"use strict";

const EARTH_RADIUS_KM = 6371;

// ---- Config (single place) ----
function getRoadFactor(env = process.env) {
  const raw = Number(
    (env && env.FARMGATE_ROAD_DISTANCE_FACTOR) ?? (env && env.FARMGATE_ROAD_FACTOR)
  );
  if (!Number.isFinite(raw) || raw < 1 || raw > 2) return 1.3;
  return raw;
}

const TIER_VERSION = "barangay-1.3-v1";

// Inclusive upper bounds on adjustedDistanceKm.
// 3.0 => ₱25, 3.1 => ₱35. The last tier has no cap (20.1+ => ₱100).
const FEE_TIERS = [
  { maxKm: 3, fee: 25, label: "0–3 km" },
  { maxKm: 6, fee: 35, label: "3.1–6 km" },
  { maxKm: 10, fee: 50, label: "6.1–10 km" },
  { maxKm: 15, fee: 65, label: "10.1–15 km" },
  { maxKm: 20, fee: 80, label: "15.1–20 km" },
  { maxKm: Infinity, fee: 100, label: "20.1 km+" },
];

class DeliveryFeeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeliveryFeeError";
    this.code = code;
  }
}

function toRadians(deg) {
  return (Number(deg) * Math.PI) / 180;
}

// Pure Haversine straight-line distance in km (unrounded).
function haversineKm(a, b) {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(s));
}

function round1(km) {
  return Math.round(Number(km) * 10) / 10;
}

// Pure fee lookup over FEE_TIERS (no if-else chain). Always returns
// { fee, tier } (last tier uncapped). Throws INVALID_DISTANCE for
// non-numeric/negative input.
function feeForAdjustedDistance(adjustedKm) {
  if (
    adjustedKm === null ||
    adjustedKm === undefined ||
    (typeof adjustedKm === "string" && adjustedKm.trim() === "")
  ) {
    throw new DeliveryFeeError(
      "INVALID_DISTANCE",
      "Invalid delivery distance. Please try quoting again."
    );
  }
  const km = Number(adjustedKm);
  if (!Number.isFinite(km) || km < 0) {
    throw new DeliveryFeeError(
      "INVALID_DISTANCE",
      "Invalid delivery distance. Please try quoting again."
    );
  }
  for (const tier of FEE_TIERS) {
    if (km <= tier.maxKm) return { fee: tier.fee, tier: tier.label };
  }
  // Unreachable while the last tier is uncapped; kept for safety.
  const last = FEE_TIERS[FEE_TIERS.length - 1];
  return { fee: last.fee, tier: last.label };
}

// Full quote for one barangay-centroid pair (pure, sync, no network).
// farmCoord / buyerCoord: { lat, lng } numbers (already looked up).
// Returns { distanceKm, adjustedDistanceKm, deliveryFee, tier, feeStatus,
//           roadFactor, tierVersion, method }. feeStatus is always "ok"
//           (the table has no cap); same-coord input yields 0 km.
function computeDeliveryFee(farmCoord, buyerCoord, opts = {}) {
  const roadFactor = opts.roadFactor || getRoadFactor(opts.env);
  const straight = haversineKm(farmCoord, buyerCoord);
  const adjustedDistanceKm = round1(straight * roadFactor);
  const hit = feeForAdjustedDistance(adjustedDistanceKm);
  return {
    distanceKm: adjustedDistanceKm,
    adjustedDistanceKm,
    deliveryFee: hit.fee,
    tier: hit.tier,
    feeStatus: "ok",
    roadFactor,
    tierVersion: TIER_VERSION,
    method: "barangay-road-factor",
  };
}

module.exports = {
  DeliveryFeeError,
  getRoadFactor,
  haversineKm,
  round1,
  feeForAdjustedDistance,
  computeDeliveryFee,
  FEE_TIERS,
  TIER_VERSION,
  EARTH_RADIUS_KM,
};
