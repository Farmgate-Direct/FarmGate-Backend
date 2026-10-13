// FarmGate delivery fee — barangay-centroid distance (Bulacan only, no GPS).
//
// Distance comes ONLY from city + barangay: same barangay on both sides is
// 0 km (₱25); otherwise haversine between the two barangay centroids ×
// ROAD_FACTOR (default 1.3), rounded to 0.1 km, then the tier lookup in
// distance.js (single config point). No municipality-center fallback for
// new orders. Client preview is NEVER trusted — the server recomputes in
// /delivery/quote, order creation, /accept (COD) and /create-payment (GCash).
"use strict";

const {
  DeliveryFeeError,
  computeDeliveryFee,
  getRoadFactor,
  FEE_TIERS,
  TIER_VERSION,
} = require("./distance");

const { BARANGAY_COORDS, CITIES } = require("./data/bulacanBarangays");

const BULACAN_PROVINCE = "Bulacan";

const normalize = (s) =>
  String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

const CITY_SET = new Set((CITIES || []).map((c) => normalize(c)));

function lookupBarangay(city, barangay) {
  const hit = BARANGAY_COORDS[`${normalize(city)}|${normalize(barangay)}`];
  if (!hit || !Number.isFinite(Number(hit.lat)) || !Number.isFinite(Number(hit.lng))) {
    return null;
  }
  return { lat: Number(hit.lat), lng: Number(hit.lng) };
}

function checkProvince(province, who) {
  if (province === null || province === undefined || String(province).trim() === "") return;
  if (normalize(province) !== normalize(BULACAN_PROVINCE)) {
    throw new DeliveryFeeError(
      "INVALID_PROVINCE",
      `${who}: delivery is Bulacan-only. Please pick an address in Bulacan.`
    );
  }
}

// Farm + buyer locations are { province?, city, barangay } (text only).
// Returns { distanceKm, adjustedDistanceKm, deliveryFee, tier, feeStatus,
//           roadFactor, tierVersion, method }.
// Same barangay (exact normalized city + barangay match) = 0 km, ₱25.
// Throws INVALID_PROVINCE / UNKNOWN_CITY / UNKNOWN_BARANGAY /
// BARANGAY_NOT_SERVICEABLE (never guesses, never substitutes).
function quoteDeliveryFee(farm, buyer, opts = {}) {
  const farmCity = farm?.city;
  const farmBarangay = farm?.barangay;
  const buyerCity = buyer?.city;
  const buyerBarangay = buyer?.barangay;
  if (!farmCity || !farmBarangay) {
    throw new DeliveryFeeError(
      "FARM_MISSING_BARANGAY",
      "This farm has no barangay set. Ask the farmer to pick their City and Barangay in Farm Profile before delivery."
    );
  }
  if (!buyerCity || !buyerBarangay) {
    throw new DeliveryFeeError(
      "ADDRESS_MISSING_BARANGAY",
      "This address has no barangay set. Please pick your City and Barangay again."
    );
  }

  checkProvince(farm?.province, "Farm location");
  checkProvince(buyer?.province, "Delivery address");

  if (!CITY_SET.has(normalize(farmCity))) {
    throw new DeliveryFeeError(
      "UNKNOWN_CITY",
      `Farm city "${farmCity}" is not a known Bulacan city/municipality.`
    );
  }
  if (!CITY_SET.has(normalize(buyerCity))) {
    throw new DeliveryFeeError(
      "UNKNOWN_CITY",
      `Delivery city "${buyerCity}" is not a known Bulacan city/municipality.`
    );
  }

  const farmCoord = lookupBarangay(farmCity, farmBarangay);
  if (!farmCoord) {
    throw new DeliveryFeeError(
      "UNKNOWN_BARANGAY",
      `Farm barangay "${farmBarangay}" is not known in ${farmCity}. Please pick it from the list.`
    );
  }
  const buyerCoord = lookupBarangay(buyerCity, buyerBarangay);
  if (!buyerCoord) {
    throw new DeliveryFeeError(
      "UNKNOWN_BARANGAY",
      `Barangay "${buyerBarangay}" is not known in ${buyerCity}. Please pick it from the list.`
    );
  }

  const roadFactor = opts.roadFactor || getRoadFactor(opts.env);

  // Same barangay (exact normalized match): 0 km, base tier. Never shortcut
  // same-CITY-different-barangay — those always compute below.
  if (
    normalize(farmCity) === normalize(buyerCity) &&
    normalize(farmBarangay) === normalize(buyerBarangay)
  ) {
    const base = FEE_TIERS[0];
    return {
      distanceKm: 0,
      adjustedDistanceKm: 0,
      deliveryFee: base.fee,
      tier: base.label,
      feeStatus: "ok",
      roadFactor,
      tierVersion: TIER_VERSION,
      method: "barangay-road-factor",
    };
  }

  return computeDeliveryFee(farmCoord, buyerCoord, { roadFactor, env: opts.env });
}

// ---- Firestore-shape helpers (pure, no db access) ----

// Farm location from users/{farmerId}: municipality/city + barangay (+ province).
// Returns { province, city, barangay } or null when city/barangay missing.
function farmLocationFromProfile(profile) {
  const p = profile || {};
  const city = p.municipality || p.city || "";
  const barangay = p.barangay || "";
  if (!String(city).trim() || !String(barangay).trim()) return null;
  return {
    province: p.province || "",
    city: String(city),
    barangay: String(barangay),
  };
}

// Buyer location from the order's saved address (text fields only).
function buyerLocationFromAddress(address) {
  const a = address || {};
  const city = a.city || a.municipality || "";
  const barangay = a.barangay || "";
  if (!String(city).trim() || !String(barangay).trim()) return null;
  return {
    province: a.province || "",
    city: String(city),
    barangay: String(barangay),
  };
}

module.exports = {
  DeliveryFeeError,
  quoteDeliveryFee,
  lookupBarangay,
  farmLocationFromProfile,
  buyerLocationFromAddress,
  normalize,
  BULACAN_PROVINCE,
  FEE_TIERS,
  TIER_VERSION,
  getRoadFactor,
};
