// deliveryService batch + rate-limit tests (pure local compute, no network).
// Run: node --test __tests__/deliveryService.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveDeliveryForOrder, resolveDeliveryBatch } = require("../deliveryService");
const { checkQuoteRateLimit, resetQuoteRateLimits } = require("../quoteRateLimit");

const FARM_A = { lat: 14.841, lng: 120.8107 }; // Malolos
const FARM_FAR = { lat: 15.14, lng: 120.9771 }; // San Miguel (49.1 km adjusted)
const FARM_CORNER = { lat: 14.41, lng: 120.51 }; // bbox SW (manual case)
const BUYER = { lat: 14.8298, lng: 120.8798 }; // Guiguinto
const BUYER_CORNER = { lat: 15.39, lng: 121.39 }; // bbox NE (manual case)

test("single: Malolos→Guiguinto = 7.5/9.8/₱75 ok", () => {
  const out = resolveDeliveryForOrder({
    farmerProfile: { farmLat: FARM_A.lat, farmLng: FARM_A.lng },
    order: { delivery: "delivery", address: { ...BUYER } },
  });
  assert.equal(out.deliveryFee, 75);
  assert.equal(out.distanceKm, 7.5);
  assert.equal(out.adjustedDistanceKm, 9.8);
  assert.equal(out.tier, ">7–12 km");
  assert.equal(out.feeStatus, "ok");
  assert.equal(out.method, "haversine-road-factor");
});

test("single: pickup has no fee and no distance", () => {
  const out = resolveDeliveryForOrder({
    farmerProfile: { farmLat: 1, farmLng: 1 },
    order: { delivery: "pickup", address: null, deliveryFee: 35 },
  });
  assert.equal(out.deliveryFee, 0);
  assert.equal(out.distanceKm, 0);
});

test("single: far farm (49.1 km) resolves ok at ₱190", () => {
  const out = resolveDeliveryForOrder({
    farmerProfile: { farmLat: FARM_FAR.lat, farmLng: FARM_FAR.lng },
    order: { delivery: "delivery", address: { ...BUYER } },
  });
  assert.equal(out.feeStatus, "ok");
  assert.equal(out.deliveryFee, 190);
  assert.equal(out.tier, ">40–50 km");
});

test("single: corner-to-corner resolves needs_manual_fee (not an error)", () => {
  const out = resolveDeliveryForOrder({
    farmerProfile: { farmLat: FARM_CORNER.lat, farmLng: FARM_CORNER.lng },
    order: { delivery: "delivery", address: { ...BUYER_CORNER } },
  });
  assert.equal(out.feeStatus, "needs_manual_fee");
  assert.equal(out.deliveryFee, null);
});

test("single: pickupLocation shape is honored", () => {
  const out = resolveDeliveryForOrder({
    farmerProfile: { pickupLocation: { lat: FARM_A.lat, lng: FARM_A.lng, address: "Farm" } },
    order: { delivery: "delivery", address: { ...BUYER } },
  });
  assert.equal(out.deliveryFee, 75);
});

test("batch: one OK + one manual resolves mixed (never rejects)", () => {
  const out = resolveDeliveryBatch({
    pairs: [
      { key: "f1", farmerId: "f1", farmerPin: FARM_FAR },
      { key: "f2", farmerId: "f2", farmerPin: FARM_CORNER },
    ],
    buyerPin: BUYER_CORNER,
  });
  assert.equal(out.length, 2);
  const ok = out.find((r) => r.key === "f1");
  const manual = out.find((r) => r.key === "f2");
  assert.equal(ok.success, true);
  assert.equal(ok.feeStatus, "ok");
  assert.equal(ok.deliveryFee, 250); // 68 km adjusted -> >60–70 km
  assert.equal(manual.success, true);
  assert.equal(manual.feeStatus, "needs_manual_fee");
  assert.equal(manual.deliveryFee, null);
});

test("batch without buyer pin fails every farm with ADDRESS_MISSING_PIN", () => {
  const out = resolveDeliveryBatch({
    pairs: [{ key: "f1", farmerId: "f1", farmerPin: FARM_A }],
    buyerPin: null,
  });
  assert.equal(out[0].success, false);
  assert.equal(out[0].code, "ADDRESS_MISSING_PIN");
});

test("batch without farm pin fails with FARM_MISSING_PICKUP", () => {
  const out = resolveDeliveryBatch({
    pairs: [{ key: "f1", farmerId: "f1", farmerPin: null }],
    buyerPin: BUYER,
  });
  assert.equal(out[0].success, false);
  assert.equal(out[0].code, "FARM_MISSING_PICKUP");
});

test("quote rate limit: 30/min allowed, 31st blocked with retry hint", () => {
  resetQuoteRateLimits();
  const uid = "rate-test-user";
  let last;
  for (let i = 0; i < 30; i++) {
    last = checkQuoteRateLimit(uid, { now: 1000 });
    assert.equal(last.allowed, true);
  }
  last = checkQuoteRateLimit(uid, { now: 1000 });
  assert.equal(last.allowed, false);
  assert.ok(last.retryAfterMs > 0);
  // Next window allows again.
  assert.equal(checkQuoteRateLimit(uid, { now: 61_001 }).allowed, true);
  resetQuoteRateLimits();
});
