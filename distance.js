// FarmGate delivery distance — Haversine straight line × road factor.
//
// Single config point for delivery pricing (change values here, not logic):
//   ROAD_FACTOR  (env FARMGATE_ROAD_FACTOR, default 1.3, clamped 1–2)
//   FEE_TIERS    (inclusive upper bounds on the ADJUSTED distance)
//   MAX_AUTO_KM  (over this -> needs_manual_fee, never auto-priced)
//   TIER_VERSION (stamped on every order for auditability)
//
// No external API calls. If a real routing provider (e.g. OpenRouteService)
// is ever plugged in, implement it behind getRoadDistance() below — the
// memo cache and the computeDeliveryFee() return shape already support it.
"use strict";

const EARTH_RADIUS_KM = 6371;

// ---- Config (single place) ----
function getRoadFactor(env = process.env) {
  const raw = Number(env && env.FARMGATE_ROAD_FACTOR);
  if (!Number.isFinite(raw) || raw < 1 || raw > 2) return 1.3;
  return raw;
}

const MAX_AUTO_KM = 70;
const TIER_VERSION = "haversine-1.3-v2";

// Inclusive upper bounds on adjustedDistanceKm.
// 3.0 => ₱30, 3.1 => ₱50. Over MAX_AUTO_KM => needs_manual_fee (fee null).
// Tiers cover full-province trips (San Miguel ↔ SJDM ≈ 60 km road-adjusted).
const FEE_TIERS = [
  { maxKm: 3, fee: 30, label: "0–3 km" },
  { maxKm: 7, fee: 50, label: ">3–7 km" },
  { maxKm: 12, fee: 75, label: ">7–12 km" },
  { maxKm: 20, fee: 100, label: ">12–20 km" },
  { maxKm: 30, fee: 130, label: ">20–30 km" },
  { maxKm: 40, fee: 160, label: ">30–40 km" },
  { maxKm: 50, fee: 190, label: ">40–50 km" },
  { maxKm: 60, fee: 220, label: ">50–60 km" },
  { maxKm: 70, fee: 250, label: ">60–70 km" },
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

// Validate raw coordinates. Returns { lat, lng } numbers.
// Throws INVALID_COORDINATES for missing/blank/non-numeric/out-of-range input.
// (Explicit null/"" check first: Number(null) is 0, which must NOT pass.)
function validateLatLng(lat, lng, who = "Location") {
  for (const v of [lat, lng]) {
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) {
      throw new DeliveryFeeError(
        "INVALID_COORDINATES",
        `${who}: missing or invalid coordinates. Please set the location again.`
      );
    }
  }
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) {
    throw new DeliveryFeeError(
      "INVALID_COORDINATES",
      `${who}: missing or invalid coordinates. Please set the location again.`
    );
  }
  if (la < -90 || la > 90 || ln < -180 || ln > 180) {
    throw new DeliveryFeeError(
      "INVALID_COORDINATES",
      `${who}: coordinates are out of range (lat -90..90, lng -180..180).`
    );
  }
  return { lat: la, lng: ln };
}

// ---- Road-distance extension point ----
// Default implementation: Haversine × ROAD_FACTOR, memoized by rounded
// coordinates (pure local compute, no network). To plug in OpenRouteService
// or similar later: replace the body with an async provider call keyed by
// the same cacheKey, keep returning adjusted km, keep the memo cache.
const roadCache = new Map(); // key -> adjusted km (0.1)
const ROAD_CACHE_MAX = 2000;

function roadCacheKey(a, b, roadFactor) {
  const p = (pin) => `${Number(pin.lat).toFixed(4)},${Number(pin.lng).toFixed(4)}`;
  const [first, second] = p(a) <= p(b) ? [p(a), p(b)] : [p(b), p(a)];
  return `${first}|${second}@${roadFactor}`;
}

function getRoadDistanceKm(a, b, opts = {}) {
  const roadFactor = opts.roadFactor || getRoadFactor(opts.env);
  const key = roadCacheKey(a, b, roadFactor);
  const hit = roadCache.get(key);
  if (hit !== undefined) return hit;
  const adjusted = round1(haversineKm(a, b) * roadFactor);
  if (roadCache.size >= ROAD_CACHE_MAX) roadCache.clear();
  roadCache.set(key, adjusted);
  return adjusted;
}

function clearRoadCache() {
  roadCache.clear();
}

// Pure fee lookup over FEE_TIERS. Returns { fee, tier } or null when over
// MAX_AUTO_KM (caller marks needs_manual_fee — never invents a fee).
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
  return null;
}

// Full quote for one farm/buyer pin pair (pure, sync, no network).
// farmPin / buyerPin: { lat, lng } (validated here).
// Returns { distanceKm, adjustedDistanceKm, deliveryFee, tier, feeStatus,
//           roadFactor, tierVersion, method }.
// feeStatus "ok" -> deliveryFee set. "needs_manual_fee" -> deliveryFee null.
function computeDeliveryFee(farmPin, buyerPin, opts = {}) {
  const roadFactor = opts.roadFactor || getRoadFactor(opts.env);
  const farm = validateLatLng(farmPin?.lat, farmPin?.lng, "Farm pickup");
  const buyer = validateLatLng(buyerPin?.lat, buyerPin?.lng, "Delivery location");
  const distanceKm = round1(haversineKm(farm, buyer));
  const adjustedDistanceKm =
    opts.adjustedKm !== undefined && opts.adjustedKm !== null
      ? round1(opts.adjustedKm)
      : getRoadDistanceKm(farm, buyer, { roadFactor, env: opts.env });
  const hit = feeForAdjustedDistance(adjustedDistanceKm);
  if (!hit) {
    return {
      distanceKm,
      adjustedDistanceKm,
      deliveryFee: null,
      tier: null,
      feeStatus: "needs_manual_fee",
      roadFactor,
      tierVersion: TIER_VERSION,
      method: "haversine-road-factor",
    };
  }
  return {
    distanceKm,
    adjustedDistanceKm,
    deliveryFee: hit.fee,
    tier: hit.tier,
    feeStatus: "ok",
    roadFactor,
    tierVersion: TIER_VERSION,
    method: "haversine-road-factor",
  };
}

module.exports = {
  DeliveryFeeError,
  getRoadFactor,
  haversineKm,
  round1,
  validateLatLng,
  getRoadDistanceKm,
  clearRoadCache,
  feeForAdjustedDistance,
  computeDeliveryFee,
  FEE_TIERS,
  MAX_AUTO_KM,
  TIER_VERSION,
  EARTH_RADIUS_KM,
};
