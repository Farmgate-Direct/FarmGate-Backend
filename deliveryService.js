// Delivery orchestration shared by /delivery/quote, order creation,
// /accept (COD) and /create-payment (validateOrderForPayment, GCash).
//
// Haversine × road factor, computed locally and synchronously — no network,
// no estimates beyond the documented ROAD_FACTOR approximation. Pins only;
// text address fields are for the courier and are never geocoded.
// Client-sent fee/distance is never read here.
//
// feeStatus "needs_manual_fee" (adjusted distance over MAX_AUTO_KM):
// deliveryFee is null and the order must NOT auto-confirm or take payment
// until the farmer sets a manual fee (POST /orders/:id/delivery-fee).
"use strict";

const {
  DeliveryFeeError,
  validatePin,
  farmPinFromProfile,
  buyerPinFromAddress,
} = require("./deliveryFee");
const { computeDeliveryFee } = require("./distance");

function storedLegacyRecord(order) {
  const stored = Number(order?.deliveryFee);
  if (!Number.isFinite(stored) || stored < 0) return null;
  const d = Number(order?.distanceKm);
  const a = Number(order?.adjustedDistanceKm);
  return {
    deliveryFee: stored,
    distanceKm: Number.isFinite(d) && d >= 0 ? d : null,
    adjustedDistanceKm: Number.isFinite(a) && a >= 0 ? a : null,
    tier: order?.deliveryTier || order?.tier || "legacy",
    feeStatus: order?.feeStatus || "ok",
    roadFactor: order?.roadFactor ?? null,
    tierVersion: order?.tierVersion || null,
    method: order?.deliveryMethod || "legacy",
    legacy: true,
  };
}

// Resolve delivery money for ONE farm/order. Sync (pure local compute).
// - pickup => zeros. - missing pins + stored fee => legacy keep.
// - missing pins otherwise => FARM_MISSING_PICKUP / ADDRESS_MISSING_PIN.
// - over MAX_AUTO_KM => needs_manual_fee with deliveryFee null (not an error:
//   the order is created/kept pending until the farmer sets the fee).
function resolveDeliveryForOrder({ farmerProfile, order }) {
  if (order?.delivery !== "delivery") {
    return {
      deliveryFee: 0,
      distanceKm: 0,
      adjustedDistanceKm: 0,
      tier: null,
      feeStatus: "ok",
      roadFactor: null,
      tierVersion: null,
      method: null,
      legacy: false,
    };
  }
  const farmPin = farmPinFromProfile(farmerProfile);
  const buyerPin = buyerPinFromAddress(order?.address);

  if (!farmPin || !buyerPin) {
    const legacy = storedLegacyRecord(order);
    if (legacy) return legacy; // old order: keep the written fee, no recompute
    if (!farmPin) {
      throw new DeliveryFeeError(
        "FARM_MISSING_PICKUP",
        "This farm has no pickup location yet. Ask the farmer to set it in Farm Profile before delivery."
      );
    }
    throw new DeliveryFeeError(
      "ADDRESS_MISSING_PIN",
      "This address has no delivery location yet. Please set your pin on the map."
    );
  }

  const farm = validatePin(farmPin, "Farm pickup");
  const buyer = validatePin(buyerPin, "Delivery location");
  const q = computeDeliveryFee(farm, buyer);
  return {
    deliveryFee: q.deliveryFee,
    distanceKm: q.distanceKm,
    adjustedDistanceKm: q.adjustedDistanceKm,
    tier: q.tier,
    feeStatus: q.feeStatus,
    roadFactor: q.roadFactor,
    tierVersion: q.tierVersion,
    method: q.method,
    legacy: false,
  };
}

// Batch quotes for checkout: ONE endpoint call for all farms in the cart.
// pairs: [{ key, farmerId, farmerPin }]. Returns [{ key, farmerId, success,
// deliveryFee, distanceKm, adjustedDistanceKm, tier, feeStatus, ... }].
// needs_manual_fee is a per-farm SUCCESS with deliveryFee null (checkout
// shows "farmer confirms fee" and blocks payment). Per-farm errors never
// reject the batch.
function resolveDeliveryBatch({ pairs, buyerPin }) {
  let buyer;
  try {
    if (!buyerPin) {
      throw new DeliveryFeeError(
        "ADDRESS_MISSING_PIN",
        "Set your delivery location on the map first."
      );
    }
    buyer = validatePin(buyerPin, "Delivery location");
  } catch (e) {
    return (pairs || []).map((p) => ({
      key: p.key,
      farmerId: p.farmerId,
      success: false,
      code: e?.code || "ADDRESS_MISSING_PIN",
      error: e?.message || "Set your delivery location on the map first.",
    }));
  }

  return (pairs || []).map((p) => {
    const out = { key: p.key, farmerId: p.farmerId };
    try {
      if (!p.farmerPin) {
        throw new DeliveryFeeError(
          "FARM_MISSING_PICKUP",
          "This farm has no pickup location yet, so delivery is blocked until the farmer sets it."
        );
      }
      const farm = validatePin(p.farmerPin, "Farm pickup");
      const q = computeDeliveryFee(farm, buyer);
      return {
        ...out,
        success: true,
        deliveryFee: q.deliveryFee,
        distanceKm: q.distanceKm,
        adjustedDistanceKm: q.adjustedDistanceKm,
        tier: q.tier,
        feeStatus: q.feeStatus,
        roadFactor: q.roadFactor,
        tierVersion: q.tierVersion,
        method: q.method,
      };
    } catch (e) {
      return {
        ...out,
        success: false,
        code: e?.code || "QUOTE_FAILED",
        error: e?.message || "Unable to quote delivery.",
      };
    }
  });
}

function pinsEqual(a, b) {
  const norm = (p) =>
    p == null || p.lat === null || p.lat === undefined || p.lng === null || p.lng === undefined
      ? null
      : `${Number(p.lat)},${Number(p.lng)}`;
  return norm(a) === norm(b);
}

// A farmer-set manual fee is honored only while the pins it was set for
// are unchanged. Otherwise the order falls back to a fresh quote (and the
// farmer must set the fee again for >20 km). Returns { deliveryFee } | null.
function manualFeeRecord(order, farmerProfile) {
  if (order?.manualFee !== true) return null;
  const fee = Number(order?.manualDeliveryFee);
  if (!Number.isFinite(fee) || fee < 0) return null;
  const saved = order?.manualFeePins || {};
  if (!pinsEqual(farmPinFromProfile(farmerProfile), saved.farm)) return null;
  if (!pinsEqual(buyerPinFromAddress(order?.address), saved.buyer)) return null;
  return { deliveryFee: Math.round(fee * 100) / 100 };
}

module.exports = {
  resolveDeliveryForOrder,
  resolveDeliveryBatch,
  manualFeeRecord,
  pinsEqual,
};
