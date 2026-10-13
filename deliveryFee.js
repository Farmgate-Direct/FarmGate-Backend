// FarmGate delivery fee — Haversine straight line × road factor.
//
// Distance = haversineKm(farm, buyer) × ROAD_FACTOR (default 1.3),
// rounded to 0.1 km BEFORE the tier lookup. Tiers live in distance.js
// (single config point). No external API calls.
//
// Pins only: the farm pickup comes from users/{farmerId} (pickupLocation,
// else farmLat/farmLng), the buyer location from the order address pin.
// Text fields are for the courier and are NEVER geocoded. Client-sent
// fee/distance is never trusted — the server recomputes everywhere.
"use strict";

const {
  DeliveryFeeError,
  feeForAdjustedDistance,
  getRoadFactor,
  FEE_TIERS,
  MAX_AUTO_KM,
  TIER_VERSION,
} = require("./distance");

// Bulacan bounding box for map pins (must match the OSM picker bbox in
// client/mobile/utils/deliveryFee.ts). Pins outside are rejected —
// delivery is Bulacan-only.
const BULACAN_BBOX = { minLat: 14.4, maxLat: 15.4, minLng: 120.5, maxLng: 121.4 };

// Pure lookup over FEE_TIERS (no if-else chain).
// Returns { fee, tier }, or null when over MAX_AUTO_KM (caller marks
// needs_manual_fee — never invents a fee).
// Throws INVALID_DISTANCE for non-numeric/negative input.
function feeForDistance(adjustedKm) {
  const hit = feeForAdjustedDistance(adjustedKm);
  return hit; // { fee, tier } | null
}

// Validate a map pin: numeric, in world range, inside the Bulacan bbox.
// Returns { lat, lng } numbers.
// Throws INVALID_PIN or PIN_OUT_OF_AREA.
function validatePin(pin, who = "Pin") {
  const rawLat = pin?.lat;
  const rawLng = pin?.lng;
  if (
    rawLat === null || rawLat === undefined || rawLng === null || rawLng === undefined ||
    (typeof rawLat === "string" && rawLat.trim() === "") ||
    (typeof rawLng === "string" && rawLng.trim() === "")
  ) {
    throw new DeliveryFeeError(
      "INVALID_PIN",
      `${who}: missing or invalid coordinates. Please set the location again.`
    );
  }
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new DeliveryFeeError(
      "INVALID_PIN",
      `${who}: missing or invalid coordinates. Please set the location again.`
    );
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new DeliveryFeeError(
      "INVALID_PIN",
      `${who}: coordinates are out of range (lat -90..90, lng -180..180).`
    );
  }
  if (
    lat < BULACAN_BBOX.minLat ||
    lat > BULACAN_BBOX.maxLat ||
    lng < BULACAN_BBOX.minLng ||
    lng > BULACAN_BBOX.maxLng
  ) {
    throw new DeliveryFeeError(
      "PIN_OUT_OF_AREA",
      `${who} is outside the Bulacan delivery area. Please set it inside Bulacan.`
    );
  }
  return { lat, lng };
}

function hasPin(pin) {
  return (
    pin != null &&
    Number.isFinite(Number(pin.lat)) &&
    Number.isFinite(Number(pin.lng))
  );
}

// ---- Firestore-shape helpers (pure, no db access) ----

// Farm pickup from users/{farmerId}. Canonical: pickupLocation { lat, lng,
// address }. Legacy farmLat/farmLng (and lat/lng aliases) still accepted.
// Returns a pin or null.
function farmPinFromProfile(profile) {
  const p = profile || {};
  const pl = p.pickupLocation || null;
  if (pl && pl.lat !== undefined && pl.lng !== undefined) {
    if (String(pl.lat) === "" || String(pl.lng) === "") return null;
    return { lat: Number(pl.lat), lng: Number(pl.lng) };
  }
  const lat = p.farmLat ?? p.lat ?? null;
  const lng = p.farmLng ?? p.lng ?? null;
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    return null;
  }
  if (String(lat) === "" || String(lng) === "") return null;
  return { lat: Number(lat), lng: Number(lng) };
}

// Buyer location from the order's saved address pin (text fields are for
// the courier only and are NEVER geocoded).
function buyerPinFromAddress(address) {
  const a = address || {};
  const lat = a.lat ?? null;
  const lng = a.lng ?? null;
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    return null;
  }
  if (String(lat) === "" || String(lng) === "") return null;
  return { lat: Number(lat), lng: Number(lng) };
}

module.exports = {
  DeliveryFeeError,
  feeForDistance,
  validatePin,
  hasPin,
  farmPinFromProfile,
  buyerPinFromAddress,
  FEE_TIERS,
  MAX_AUTO_KM,
  TIER_VERSION,
  BULACAN_BBOX,
  getRoadFactor,
};
