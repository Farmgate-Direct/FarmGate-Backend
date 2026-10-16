// Shared delivery quoting for quote, order creation, accept, and payment.
// Local compute only, no network. Client-sent fees are never read.
"use strict";

const {
  DeliveryFeeError,
  quoteDeliveryFee,
  farmLocationFromProfile,
  buyerLocationFromAddress,
} = require("./deliveryFee");

function storedLegacyRecord(order) {
  const stored = Number(order?.deliveryFee);
  if (!Number.isFinite(stored) || stored < 0) return null;
  const d = Number(order?.distanceKm);
  return {
    deliveryFee: stored,
    distanceKm: Number.isFinite(d) && d >= 0 ? d : null,
    adjustedDistanceKm: Number.isFinite(Number(order?.adjustedDistanceKm))
      ? Number(order.adjustedDistanceKm)
      : Number.isFinite(d) && d >= 0
        ? d
        : null,
    tier: order?.deliveryTier || order?.tier || "legacy",
    feeStatus: "ok",
    roadFactor: order?.roadFactor ?? null,
    tierVersion: order?.tierVersion || null,
    method: order?.deliveryMethod || "legacy",
    legacy: true,
  };
}

// Resolve delivery money for ONE farm/order. Sync (pure local compute).
// - pickup => zeros. - missing barangay + stored fee => legacy keep.
// - missing farm barangay otherwise => FARM_MISSING_BARANGAY.
// - missing buyer barangay otherwise => ADDRESS_MISSING_BARANGAY.
// - undeliverable names propagate (caller keeps the order pending).
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
  const farm = farmLocationFromProfile(farmerProfile);
  const buyer = buyerLocationFromAddress(order?.address);

  if (!farm || !buyer) {
    const legacy = storedLegacyRecord(order);
    if (legacy) return legacy; // old order: keep the written fee, no recompute
    if (!farm) {
      throw new DeliveryFeeError(
        "FARM_MISSING_BARANGAY",
        "This farm has no barangay set. Ask the farmer to pick their City and Barangay in Farm Profile before delivery."
      );
    }
    throw new DeliveryFeeError(
      "ADDRESS_MISSING_BARANGAY",
      "This address has no barangay set. Please pick your City and Barangay again."
    );
  }

  const q = quoteDeliveryFee(farm, buyer);
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
// pairs: [{ key, farmerId, farmerLocation }]. Returns [{ key, farmerId,
// success, deliveryFee, distanceKm, adjustedDistanceKm, tier, ... }].
// Per-farm failures never reject the batch.
function resolveDeliveryBatch({ pairs, buyerLocation }) {
  let buyer = buyerLocation || null;
  if (!buyer || !buyer.city || !buyer.barangay) {
    const e = new DeliveryFeeError(
      "ADDRESS_MISSING_BARANGAY",
      "Pick your City and Barangay first."
    );
    return (pairs || []).map((p) => ({
      key: p.key,
      farmerId: p.farmerId,
      success: false,
      code: e.code,
      error: e.message,
    }));
  }

  return (pairs || []).map((p) => {
    const out = { key: p.key, farmerId: p.farmerId };
    try {
      if (!p.farmerLocation) {
        throw new DeliveryFeeError(
          "FARM_MISSING_BARANGAY",
          "This farm has no barangay set, so delivery is blocked until the farmer picks it."
        );
      }
      const q = quoteDeliveryFee(p.farmerLocation, buyer);
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

module.exports = {
  resolveDeliveryForOrder,
  resolveDeliveryBatch,
};
