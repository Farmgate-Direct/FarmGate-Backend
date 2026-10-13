// Unit tests for distance.js (Haversine × road factor, data-driven tiers).
// Run: node --test __tests__/distance.test.js
// No network, no external APIs — everything here is pure local compute.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DeliveryFeeError,
  getRoadFactor,
  haversineKm,
  validateLatLng,
  feeForAdjustedDistance,
  computeDeliveryFee,
  getRoadDistanceKm,
  clearRoadCache,
  FEE_TIERS,
  MAX_AUTO_KM,
  TIER_VERSION,
} = require("../distance");

test("config: 9 data-driven tiers, 70 km auto max, version stamped", () => {
  assert.ok(Array.isArray(FEE_TIERS));
  assert.equal(FEE_TIERS.length, 9);
  assert.equal(MAX_AUTO_KM, 70);
  assert.equal(typeof TIER_VERSION, "string");
});

test("getRoadFactor: default 1.3, clamps 1–2, honors env", () => {
  assert.equal(getRoadFactor({}), 1.3);
  assert.equal(getRoadFactor({ FARMGATE_ROAD_FACTOR: "1.3" }), 1.3);
  assert.equal(getRoadFactor({ FARMGATE_ROAD_FACTOR: "0.5" }), 1.3);
  assert.equal(getRoadFactor({ FARMGATE_ROAD_FACTOR: "9" }), 1.3);
  assert.equal(getRoadFactor({ FARMGATE_ROAD_FACTOR: "abc" }), 1.3);
  assert.equal(getRoadFactor({ FARMGATE_ROAD_FACTOR: "1.5" }), 1.5);
});

test("haversine: zero for same pin, ~7.5 km Malolos→Guiguinto", () => {
  const a = { lat: 14.841, lng: 120.8107 };
  assert.equal(haversineKm(a, { ...a }), 0);
  const b = { lat: 14.8298, lng: 120.8798 };
  const km = haversineKm(a, b);
  assert.ok(km > 7 && km < 8, `got ${km}`);
  assert.equal(haversineKm(a, b), haversineKm(b, a)); // symmetric
});

test("validateLatLng: numbers pass, junk and out-of-range throw", () => {
  assert.deepEqual(validateLatLng("14.841", "120.8107"), { lat: 14.841, lng: 120.8107 });
  for (const [lat, lng] of [
    [NaN, 120.8], ["abc", 120.8], [14.8, "x"], [null, null], [undefined, undefined],
    [91, 120.8], [-91, 120.8], [14.8, 181], [14.8, -181],
  ]) {
    assert.throws(
      () => validateLatLng(lat, lng),
      (e) => e instanceof DeliveryFeeError && e.code === "INVALID_COORDINATES",
      `input ${lat},${lng}`
    );
  }
  // World range edges are fine (bbox checks live in validatePin).
  assert.deepEqual(validateLatLng(-90, -180), { lat: -90, lng: -180 });
  assert.deepEqual(validateLatLng(90, 180), { lat: 90, lng: 180 });
});

const BOUNDARIES = [
  [3.0, 30, "0–3 km", 3.1, 50, ">3–7 km"],
  [7.0, 50, ">3–7 km", 7.1, 75, ">7–12 km"],
  [12.0, 75, ">7–12 km", 12.1, 100, ">12–20 km"],
];

for (const [low, lowFee, lowTier, high, highFee, highTier] of BOUNDARIES) {
  test(`tier boundary: ${low} km = ₱${lowFee}, ${high} km = ₱${highFee}`, () => {
    assert.deepEqual(feeForAdjustedDistance(low), { fee: lowFee, tier: lowTier });
    assert.deepEqual(feeForAdjustedDistance(high), { fee: highFee, tier: highTier });
  });
}

test("20.0 km = ₱100; 20.1 km = ₱130 (>20–30 km tier)", () => {
  assert.deepEqual(feeForAdjustedDistance(20.0), { fee: 100, tier: ">12–20 km" });
  assert.deepEqual(feeForAdjustedDistance(20.1), { fee: 130, tier: ">20–30 km" });
});

test("70.0 km is auto (₱250); 70.1 km is manual (null, never a fee)", () => {
  assert.deepEqual(feeForAdjustedDistance(70.0), { fee: 250, tier: ">60–70 km" });
  assert.equal(feeForAdjustedDistance(70.1), null);
  assert.equal(feeForAdjustedDistance(120), null);
});

test("invalid distances throw INVALID_DISTANCE (never a fee)", () => {
  for (const bad of [NaN, -1, "abc", undefined, null]) {
    assert.throws(
      () => feeForAdjustedDistance(bad),
      (e) => e instanceof DeliveryFeeError && e.code === "INVALID_DISTANCE",
      `input ${String(bad)}`
    );
  }
});

test("computeDeliveryFee: same pin = 0 km straight, 0 adjusted, ₱30", () => {
  const a = { lat: 14.841, lng: 120.8107 };
  const q = computeDeliveryFee(a, { ...a });
  assert.equal(q.distanceKm, 0);
  assert.equal(q.adjustedDistanceKm, 0);
  assert.equal(q.deliveryFee, 30);
  assert.equal(q.tier, "0–3 km");
  assert.equal(q.feeStatus, "ok");
  assert.equal(q.roadFactor, 1.3);
  assert.equal(q.tierVersion, TIER_VERSION);
});

test("computeDeliveryFee: Malolos→Guiguinto = 7.5/9.8/₱75 ok", () => {
  const q = computeDeliveryFee(
    { lat: 14.841, lng: 120.8107 },
    { lat: 14.8298, lng: 120.8798 }
  );
  assert.equal(q.distanceKm, 7.5);
  assert.equal(q.adjustedDistanceKm, 9.8);
  assert.equal(q.deliveryFee, 75);
  assert.equal(q.tier, ">7–12 km");
  assert.equal(q.feeStatus, "ok");
});

test("computeDeliveryFee: Malolos→San Miguel = 37.7/49.1/₱190 ok", () => {
  const q = computeDeliveryFee(
    { lat: 14.841, lng: 120.8107 },
    { lat: 15.14, lng: 120.9771 }
  );
  assert.equal(q.feeStatus, "ok");
  assert.equal(q.deliveryFee, 190);
  assert.equal(q.tier, ">40–50 km");
  assert.ok(q.adjustedDistanceKm > 20);
});

test("computeDeliveryFee: corner-to-corner Bulacan = manual (null fee)", () => {
  const q = computeDeliveryFee(
    { lat: 14.41, lng: 120.51 },
    { lat: 15.39, lng: 121.39 }
  );
  assert.equal(q.feeStatus, "needs_manual_fee");
  assert.equal(q.deliveryFee, null);
  assert.equal(q.tier, null);
  assert.ok(q.adjustedDistanceKm > 70);
});

test("computeDeliveryFee: bad pins throw INVALID_COORDINATES", () => {
  assert.throws(
    () => computeDeliveryFee({ lat: "x", lng: 1 }, { lat: 2, lng: 3 }),
    (e) => e instanceof DeliveryFeeError && e.code === "INVALID_COORDINATES"
  );
});

test("getRoadDistanceKm: memoized, road-factor aware", () => {
  clearRoadCache();
  const a = { lat: 14.841, lng: 120.8107 };
  const b = { lat: 14.8298, lng: 120.8798 };
  assert.equal(getRoadDistanceKm(a, b, { roadFactor: 1.3 }), 9.8);
  assert.equal(getRoadDistanceKm(b, a, { roadFactor: 1.3 }), 9.8); // order-free
  assert.equal(getRoadDistanceKm(a, b, { roadFactor: 1.5 }), 11.3);
  clearRoadCache();
});
