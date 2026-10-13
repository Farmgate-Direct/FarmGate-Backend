// Unit tests for distance.js (barangay-centroid Haversine × road factor).
// Run: node --test __tests__/distance.test.js
// No network, no external APIs — everything here is pure local compute.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DeliveryFeeError,
  getRoadFactor,
  haversineKm,
  feeForAdjustedDistance,
  computeDeliveryFee,
  FEE_TIERS,
  TIER_VERSION,
} = require("../distance");

test("config: 11 data-driven tiers capped at 70 km, version stamped", () => {
  assert.ok(Array.isArray(FEE_TIERS));
  assert.equal(FEE_TIERS.length, 11);
  assert.equal(FEE_TIERS[10].maxKm, 70);
  assert.equal(typeof TIER_VERSION, "string");
});

test("getRoadFactor: default 1.3, both env names, clamps 1–2", () => {
  assert.equal(getRoadFactor({}), 1.3);
  assert.equal(getRoadFactor({ FARMGATE_ROAD_DISTANCE_FACTOR: "1.5" }), 1.5);
  assert.equal(getRoadFactor({ FARMGATE_ROAD_FACTOR: "1.5" }), 1.5);
  assert.equal(getRoadFactor({ FARMGATE_ROAD_DISTANCE_FACTOR: "0.5" }), 1.3);
  assert.equal(getRoadFactor({ FARMGATE_ROAD_DISTANCE_FACTOR: "9" }), 1.3);
  assert.equal(getRoadFactor({ FARMGATE_ROAD_DISTANCE_FACTOR: "abc" }), 1.3);
});

test("haversine: zero for same coord, ~1.89 km San Isidro→Iba (Hagonoy)", () => {
  const a = { lat: 14.8661, lng: 120.7392 };
  assert.equal(haversineKm(a, { ...a }), 0);
  const b = { lat: 14.8655, lng: 120.7568 };
  const km = haversineKm(a, b);
  assert.ok(km > 1.8 && km < 2.0, `got ${km}`);
  assert.equal(haversineKm(a, b), haversineKm(b, a)); // symmetric
});

test("tier boundary: 3.0 km = ₱25, 3.1 km = ₱35", () => {
  assert.deepEqual(feeForAdjustedDistance(3.0), { fee: 25, tier: "0–3 km" });
  assert.deepEqual(feeForAdjustedDistance(3.1), { fee: 35, tier: "3.1–5 km" });
});

test("all tier boundaries (inclusive upper bounds)", () => {
  const cases = [
    [3.0, 25, "0–3 km"], [3.1, 35, "3.1–5 km"],
    [5.0, 35, "3.1–5 km"], [5.1, 50, "5.1–10 km"],
    [10.0, 50, "5.1–10 km"], [10.1, 70, "10.1–15 km"],
    [15.0, 70, "10.1–15 km"], [15.1, 90, "15.1–20 km"],
    [20.0, 90, "15.1–20 km"], [20.1, 110, "20.1–25 km"],
    [25.0, 110, "20.1–25 km"], [25.1, 130, "25.1–30 km"],
    [30.0, 130, "25.1–30 km"], [30.1, 160, "30.1–40 km"],
    [40.0, 160, "30.1–40 km"], [40.1, 190, "40.1–50 km"],
    [50.0, 190, "40.1–50 km"], [50.1, 220, "50.1–60 km"],
    [60.0, 220, "50.1–60 km"], [60.1, 250, "60.1–70 km"],
    [70.0, 250, "60.1–70 km"],
  ];
  for (const [km, fee, tier] of cases) {
    assert.deepEqual(feeForAdjustedDistance(km), { fee, tier }, `${km} km`);
  }
});

test("70.1 km throws TOO_FAR (delivery blocked, never a fee)", () => {
  for (const bad of [70.1, 120]) {
    assert.throws(
      () => feeForAdjustedDistance(bad),
      (e) => e instanceof DeliveryFeeError && e.code === "TOO_FAR",
      `input ${bad}`
    );
  }
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

test("computeDeliveryFee: identical coords = 0 km, ₱25, ok", () => {
  const a = { lat: 14.8661, lng: 120.7392 };
  const q = computeDeliveryFee(a, { ...a });
  assert.equal(q.distanceKm, 0);
  assert.equal(q.adjustedDistanceKm, 0);
  assert.equal(q.deliveryFee, 25);
  assert.equal(q.tier, "0–3 km");
  assert.equal(q.feeStatus, "ok");
  assert.equal(q.roadFactor, 1.3);
  assert.equal(q.tierVersion, TIER_VERSION);
  assert.equal(q.method, "barangay-road-factor");
});

test("computeDeliveryFee: San Isidro→Iba = 2.5 km adjusted, ₱25", () => {
  const q = computeDeliveryFee(
    { lat: 14.8661, lng: 120.7392 },
    { lat: 14.8655, lng: 120.7568 }
  );
  assert.equal(q.distanceKm, 2.5);
  assert.equal(q.adjustedDistanceKm, 2.5);
  assert.equal(q.deliveryFee, 25);
  assert.equal(q.tier, "0–3 km");
  assert.equal(q.feeStatus, "ok");
});

test("computeDeliveryFee: corner-to-corner Bulacan throws TOO_FAR", () => {
  assert.throws(
    () =>
      computeDeliveryFee(
        { lat: 14.41, lng: 120.51 },
        { lat: 15.39, lng: 121.39 }
      ),
    (e) => e instanceof DeliveryFeeError && e.code === "TOO_FAR"
  );
});
