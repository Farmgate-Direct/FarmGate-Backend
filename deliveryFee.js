// FarmGate delivery fee — OSRM road distance (Bulacan only, pins only).
//
// Distance comes from the self-hosted OSRM instance (see osrm/README.md),
// converted to km and rounded to 0.1 km BEFORE the tier lookup below.
// This module is pure: feeForDistance(distanceKm) -> { fee, tier }.
// It never estimates, never geocodes, never calls the network.
// Client preview is NEVER trusted; the server recomputes in
// /delivery/quote, /accept (COD) and /create-payment
// (validateOrderForPayment, GCash).
"use strict";

// Bulacan bounding box (must match the OSM extract bbox in osrm/README.md).
// Pins outside this box are rejected — delivery is Bulacan-only.
const BULACAN_BBOX = { minLat: 14.4, maxLat: 15.4, minLng: 120.5, maxLng: 121.4 };

// Rate table, INCLUSIVE upper bounds, in data (no if-else chain).
// Distance must already be rounded to 0.1 km: 3.0 => ₱25, 3.1 => ₱35.
// Over 70 km: blocked (TOO_FAR). Same pin (0 km): ₱25.
const FEE_TIERS = [
  { maxKm: 3, fee: 25, label: "0–3 km" },
  { maxKm: 5, fee: 35, label: "3.1–5 km" },
  { maxKm: 10, fee: 50, label: "5.1–10 km" },
  { maxKm: 15, fee: 70, label: "10.1–15 km" },
  { maxKm: 20, fee: 90, label: "15.1–20 km" },
  { maxKm: 25, fee: 110, label: "20.1–25 km" },
  { maxKm: 30, fee: 130, label: "25.1–30 km" },
  { maxKm: 40, fee: 160, label: "30.1–40 km" },
  { maxKm: 50, fee: 190, label: "40.1–50 km" },
  { maxKm: 60, fee: 220, label: "50.1–60 km" },
  { maxKm: 70, fee: 250, label: "60.1–70 km" },
];

const MAX_DELIVERY_KM = 70;

class DeliveryFeeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeliveryFeeError";
    this.code = code;
  }
}

// Pure lookup over the FEE_TIERS data above (no if-else chain).
// Throws DeliveryFeeError TOO_FAR when distanceKm > 70,
// INVALID_DISTANCE for non-numeric/negative input.
function feeForDistance(distanceKm) {
  if (
    distanceKm === null ||
    distanceKm === undefined ||
    (typeof distanceKm === "string" && distanceKm.trim() === "")
  ) {
    throw new DeliveryFeeError(
      "INVALID_DISTANCE",
      "Invalid delivery distance. Please try quoting again."
    );
  }
  const km = Number(distanceKm);
  if (!Number.isFinite(km) || km < 0) {
    throw new DeliveryFeeError(
      "INVALID_DISTANCE",
      "Invalid delivery distance. Please try quoting again."
    );
  }
  for (const tier of FEE_TIERS) {
    if (km <= tier.maxKm) {
      return { fee: tier.fee, tier: tier.label };
    }
  }
  throw new DeliveryFeeError(
    "TOO_FAR",
    `This delivery is ${km.toFixed(1)} km — over the 70 km Bulacan delivery limit.`
  );
}

// Round an OSRM meter value to 0.1 km (single place this happens).
function roundDistanceKm(meters) {
  const km = Number(meters) / 1000;
  if (!Number.isFinite(km) || km < 0) {
    throw new DeliveryFeeError(
      "INVALID_DISTANCE",
      "Invalid delivery distance. Please try quoting again."
    );
  }
  return Math.round(km * 10) / 10;
}

// Validate a dropped map pin. Returns { lat, lng } as numbers.
// Throws INVALID_PIN (non-numeric or out of world range) or
// PIN_OUT_OF_AREA (outside the Bulacan bbox).
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
      `${who}: missing or invalid coordinates. Please drop the map pin again.`
    );
  }
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new DeliveryFeeError(
      "INVALID_PIN",
      `${who}: missing or invalid coordinates. Please drop the map pin again.`
    );
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new DeliveryFeeError(
      "INVALID_PIN",
      `${who}: coordinates are out of range. Please drop the map pin again.`
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
      `${who} is outside the Bulacan delivery area. Please drop the pin inside Bulacan.`
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

// Farm pin from users/{farmerId}. Stored as farmLat/farmLng
// (legacy aliases lat/lng also accepted). Returns a pin or null.
function farmPinFromProfile(profile) {
  const p = profile || {};
  const lat = p.farmLat ?? p.lat ?? null;
  const lng = p.farmLng ?? p.lng ?? null;
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    return null;
  }
  if (String(lat) === "" || String(lng) === "") return null;
  return { lat: Number(lat), lng: Number(lng) };
}

// Buyer pin from the order's saved address. Text fields (street/city/
// barangay) are kept for the courier only and are NEVER geocoded.
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
  roundDistanceKm,
  validatePin,
  hasPin,
  farmPinFromProfile,
  buyerPinFromAddress,
  FEE_TIERS,
  MAX_DELIVERY_KM,
  BULACAN_BBOX,
};
