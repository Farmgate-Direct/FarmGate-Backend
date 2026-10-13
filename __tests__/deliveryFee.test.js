// Unit tests for deliveryFee (OSRM pins, data-driven rate table).
// Run: node --test __tests__/deliveryFee.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { feeForDistance, DeliveryFeeError, FEE_TIERS } = require("../deliveryFee");

test("rate table is data (array), not an if-else chain", () => {
  assert.ok(Array.isArray(FEE_TIERS));
  assert.equal(FEE_TIERS.length, 11);
});

test("0 km (same pin) = ₱25", () => {
  assert.deepEqual(feeForDistance(0), { fee: 25, tier: "0–3 km" });
});

const BOUNDARIES = [
  [3.0, 25, "0–3 km", 3.1, 35, "3.1–5 km"],
  [5.0, 35, "3.1–5 km", 5.1, 50, "5.1–10 km"],
  [10.0, 50, "5.1–10 km", 10.1, 70, "10.1–15 km"],
  [15.0, 70, "10.1–15 km", 15.1, 90, "15.1–20 km"],
  [20.0, 90, "15.1–20 km", 20.1, 110, "20.1–25 km"],
  [25.0, 110, "20.1–25 km", 25.1, 130, "25.1–30 km"],
  [30.0, 130, "25.1–30 km", 30.1, 160, "30.1–40 km"],
  [40.0, 160, "30.1–40 km", 40.1, 190, "40.1–50 km"],
  [50.0, 190, "40.1–50 km", 50.1, 220, "50.1–60 km"],
  [60.0, 220, "50.1–60 km", 60.1, 250, "60.1–70 km"],
];

for (const [low, lowFee, lowTier, high, highFee, highTier] of BOUNDARIES) {
  test(`tier boundary: ${low} km = ₱${lowFee}, ${high} km = ₱${highFee}`, () => {
    assert.deepEqual(feeForDistance(low), { fee: lowFee, tier: lowTier });
    assert.deepEqual(feeForDistance(high), { fee: highFee, tier: highTier });
  });
}

test("70.0 km is allowed (₱250); 70.1 km is blocked", () => {
  assert.deepEqual(feeForDistance(70.0), { fee: 250, tier: "60.1–70 km" });
  assert.throws(
    () => feeForDistance(70.1),
    (e) => e instanceof DeliveryFeeError && e.code === "TOO_FAR"
  );
});

test("over 70 km is blocked (no fee returned)", () => {
  assert.throws(
    () => feeForDistance(120),
    (e) => e instanceof DeliveryFeeError && e.code === "TOO_FAR"
  );
});

test("invalid distances throw INVALID_DISTANCE (never a fee)", () => {
  for (const bad of [NaN, -1, "abc", undefined, null]) {
    assert.throws(
      () => feeForDistance(bad),
      (e) => e instanceof DeliveryFeeError && e.code === "INVALID_DISTANCE",
      `input ${String(bad)}`
    );
  }
});
