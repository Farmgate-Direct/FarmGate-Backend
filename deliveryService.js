// Delivery orchestration shared by /delivery/quote, /accept (COD) and
// /create-payment (validateOrderForPayment, GCash).
//
// Pins only — text address fields are for the courier and are never
// geocoded. Client-sent fee/distance is never read here.
// Distances for all farms in one order are fetched in parallel
// (Promise.all) with the osrmClient timeout. The fee/distance/total
// written to the order must not change after the buyer pays (callers
// store distanceKm, deliveryFee, deliveryTier, osrmDataVersion and
// method "osrm" on the order; post-pay paths reject paid orders).
"use strict";

const {
  DeliveryFeeError,
  feeForDistance,
  validatePin,
  farmPinFromProfile,
  buyerPinFromAddress,
} = require("./deliveryFee");
const { cacheKeyFor, readCache, readCacheTx, writeCache } = require("./deliveryCache");
const { getRouteDistanceKm, getDataVersion } = require("./osrmClient");

function storedLegacyRecord(order) {
  const stored = Number(order?.deliveryFee);
  if (!Number.isFinite(stored) || stored < 0) return null;
  const d = Number(order?.distanceKm);
  return {
    deliveryFee: stored,
    distanceKm: Number.isFinite(d) && d >= 0 ? d : null,
    tier: order?.deliveryTier || order?.tier || "legacy",
    osrmDataVersion: order?.osrmDataVersion || null,
    method: order?.deliveryMethod || "legacy",
    legacy: true,
  };
}

// Default distance fetch: cache-first, OSRM on miss (writes cache).
function defaultGetDistanceKm(db) {
  return async (farmPin, buyerPin) => {
    const osrmDataVersion = getDataVersion();
    const key = cacheKeyFor(farmPin, buyerPin, osrmDataVersion);
    const hit = await readCache(db, key);
    if (hit) {
      return { distanceKm: hit.distanceKm, osrmDataVersion: hit.osrmDataVersion || osrmDataVersion, cached: true };
    }
    const r = await getRouteDistanceKm(farmPin, buyerPin);
    await writeCache(db, key, { distanceKm: r.distanceKm, osrmDataVersion: r.osrmDataVersion });
    return { distanceKm: r.distanceKm, osrmDataVersion: r.osrmDataVersion, cached: false };
  };
}

// Resolve delivery money for ONE farm/order. Async (may call OSRM).
// opts: { db, transaction?, farmerProfile, order, getDistanceKm? }
// - pickup => zeros. - missing pins + stored fee => legacy keep.
// - missing pins otherwise => FARM_MISSING_PIN / ADDRESS_MISSING_PIN.
// - NO_ROUTE / TOO_FAR / UNAVAILABLE / PIN errors propagate (caller keeps
//   the order pending and returns a clear error).
async function resolveDeliveryForOrder({ db, transaction, farmerProfile, order, getDistanceKm }) {
  if (order?.delivery !== "delivery") {
    return { deliveryFee: 0, distanceKm: 0, tier: null, osrmDataVersion: null, method: null, legacy: false };
  }
  const farmPin = farmPinFromProfile(farmerProfile);
  const buyerPin = buyerPinFromAddress(order?.address);

  if (!farmPin || !buyerPin) {
    const legacy = storedLegacyRecord(order);
    if (legacy) return legacy; // old order: keep the written fee, no recompute
    if (!farmPin) {
      throw new DeliveryFeeError(
        "FARM_MISSING_PIN",
        "This farm has no map pin yet. Ask the farmer to set their pin in Farm Profile before delivery."
      );
    }
    throw new DeliveryFeeError(
      "ADDRESS_MISSING_PIN",
      "This address has no map pin yet. Please set your pin on the map."
    );
  }

  const farm = validatePin(farmPin, "Farm pin");
  const buyer = validatePin(buyerPin, "Delivery pin");
  const fetchFn = getDistanceKm || defaultGetDistanceKm(db);

  let distanceKm;
  let osrmDataVersion;
  if (transaction) {
    const key = cacheKeyFor(farm, buyer, getDataVersion());
    const hit = await readCacheTx(transaction, db, key);
    if (hit) {
      distanceKm = hit.distanceKm;
      osrmDataVersion = hit.osrmDataVersion || getDataVersion();
    } else {
      const r = await fetchFn(farm, buyer);
      distanceKm = r.distanceKm;
      osrmDataVersion = r.osrmDataVersion || getDataVersion();
      await writeCache(db, key, { distanceKm, osrmDataVersion });
    }
  } else {
    const r = await fetchFn(farm, buyer);
    distanceKm = r.distanceKm;
    osrmDataVersion = r.osrmDataVersion || getDataVersion();
  }

  const { fee, tier } = feeForDistance(distanceKm);
  return { deliveryFee: fee, distanceKm, tier, osrmDataVersion, method: "osrm", legacy: false };
}

// Batch quotes for checkout: ONE endpoint call, parallel on the server.
// pairs: [{ key, farmerPin }]. Returns [{ key, success, deliveryFee,
// distanceKm, tier, osrmDataVersion, method, code?, error? }].
// Per-farm failures never reject the batch.
async function resolveDeliveryBatch({ db, pairs, buyerPin, getDistanceKm }) {
  const fetchFn = getDistanceKm || defaultGetDistanceKm(db);
  let buyer;
  try {
    if (!buyerPin) {
      throw new DeliveryFeeError(
        "ADDRESS_MISSING_PIN",
        "Set your delivery pin on the map first."
      );
    }
    buyer = validatePin(buyerPin, "Delivery pin");
  } catch (e) {
    return (pairs || []).map((p) => ({
      key: p.key,
      farmerId: p.farmerId,
      success: false,
      code: e?.code || "ADDRESS_MISSING_PIN",
      error: e?.message || "Set your delivery pin on the map first.",
    }));
  }

  return Promise.all(
    (pairs || []).map(async (p) => {
      const out = { key: p.key, farmerId: p.farmerId };
      try {
        if (!p.farmerPin) {
          throw new DeliveryFeeError(
            "FARM_MISSING_PIN",
            "This farm has no map pin yet, so delivery is blocked until the farmer sets it."
          );
        }
        const farm = validatePin(p.farmerPin, "Farm pin");
        const key = cacheKeyFor(farm, buyer, getDataVersion());
        let distanceKm;
        let osrmDataVersion;
        const hit = await readCache(db, key);
        if (hit) {
          distanceKm = hit.distanceKm;
          osrmDataVersion = hit.osrmDataVersion || getDataVersion();
        } else {
          const r = await fetchFn(farm, buyer);
          distanceKm = r.distanceKm;
          osrmDataVersion = r.osrmDataVersion || getDataVersion();
          await writeCache(db, key, { distanceKm, osrmDataVersion });
        }
        const { fee, tier } = feeForDistance(distanceKm);
        return { ...out, success: true, deliveryFee: fee, distanceKm, tier, osrmDataVersion, method: "osrm" };
      } catch (e) {
        return {
          ...out,
          success: false,
          code: e?.code || (e?.name === "OsrmError" ? "UNAVAILABLE" : "UNAVAILABLE"),
          error: e?.message || "Unable to quote delivery.",
        };
      }
    })
  );
}

module.exports = {
  resolveDeliveryForOrder,
  resolveDeliveryBatch,
  defaultGetDistanceKm,
  pinsEqual,
};

function pinsEqual(a, b) {
  const norm = (p) =>
    p == null || p.lat === null || p.lat === undefined || p.lng === null || p.lng === undefined
      ? null
      : `${Number(p.lat)},${Number(p.lng)}`;
  return norm(a) === norm(b);
}
