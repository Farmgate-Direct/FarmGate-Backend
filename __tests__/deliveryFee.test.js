// Unit tests for deliveryFee (Haversine tiers + pin shapes).
// Run: node --test __tests__/deliveryFee.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  feeForDistance,
  farmPinFromProfile,
  buyerPinFromAddress,
  hasPin,
  FEE_TIERS,
  MAX_AUTO_KM,
} = require("../deliveryFee");

test("rate table is data (array), not an if-else chain", () => {
  assert.ok(Array.isArray(FEE_TIERS));
  assert.equal(FEE_TIERS.length, 4);
  assert.equal(MAX_AUTO_KM, 20);
});

test("0 km (same pin) = ₱30", () => {
  assert.deepEqual(feeForDistance(0), { fee: 30, tier: "0–3 km" });
});

const BOUNDARIES = [
  [3.0, 30, "0–3 km", 3.1, 50, ">3–7 km"],
  [7.0, 50, ">3–7 km", 7.1, 75, ">7–12 km"],
  [12.0, 75, ">7–12 km", 12.1, 100, ">12–20 km"],
];

for (const [low, lowFee, lowTier, high, highFee, highTier] of BOUNDARIES) {
  test(`tier boundary: ${low} km = ₱${lowFee}, ${high} km = ₱${highFee}`, () => {
    assert.deepEqual(feeForDistance(low), { fee: lowFee, tier: lowTier });
    assert.deepEqual(feeForDistance(high), { fee: highFee, tier: highTier });
  });
}

test("20.0 km is auto (₱100); 20.1 km returns null (manual, never a fee)", () => {
  assert.deepEqual(feeForDistance(20.0), { fee: 100, tier: ">12–20 km" });
  assert.equal(feeForDistance(20.1), null);
});

test("farm pickup prefers pickupLocation, falls back to farmLat/farmLng", () => {
  assert.deepEqual(
    farmPinFromProfile({
      pickupLocation: { lat: 14.9, lng: 120.9, address: "Farm" },
      farmLat: 14.1,
      farmLng: 120.1,
    }),
    { lat: 14.9, lng: 120.9 }
  );
  assert.deepEqual(
    farmPinFromProfile({ farmLat: 14.841, farmLng: 120.8107 }),
    { lat: 14.841, lng: 120.8107 }
  );
  assert.equal(farmPinFromProfile({ farmName: "No pin" }), null);
  assert.equal(farmPinFromProfile({ pickupLocation: { lat: "", lng: "" } }), null);
});

test("buyer pin comes from address lat/lng only (never text)", () => {
  assert.deepEqual(
    buyerPinFromAddress({ city: "Malolos", barangay: "X", lat: 14.8, lng: 120.8 }),
    { lat: 14.8, lng: 120.8 }
  );
  assert.equal(buyerPinFromAddress({ city: "Malolos", barangay: "X" }), null);
});

test("hasPin guards missing coordinates", () => {
  assert.equal(hasPin({ lat: 14.8, lng: 120.8 }), true);
  assert.equal(hasPin(null), false);
  assert.equal(hasPin({}), false);
});
