// deliveryService batch tests (pure local compute, no network).
// Run: node --test __tests__/deliveryService.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveDeliveryForOrder, resolveDeliveryBatch } = require("../deliveryService");
const { checkQuoteRateLimit, resetQuoteRateLimits } = require("../quoteRateLimit");

const buyer = (city, barangay) => ({ province: "Bulacan", city, barangay });
const farmProfile = (city, barangay) => ({ municipality: city, barangay, province: "Bulacan" });

test("single: Hagonoy San Isidro→Iba = 2.5 km, ₱25, ok", () => {
  const out = resolveDeliveryForOrder({
    farmerProfile: farmProfile("Hagonoy", "San Isidro"),
    order: { delivery: "delivery", address: buyer("Hagonoy", "Iba") },
  });
  assert.equal(out.deliveryFee, 25);
  assert.equal(out.distanceKm, 2.5);
  assert.equal(out.tier, "0–3 km");
  assert.equal(out.feeStatus, "ok");
  assert.equal(out.method, "barangay-road-factor");
});

test("single: same barangay = 0 km, ₱25", () => {
  const out = resolveDeliveryForOrder({
    farmerProfile: farmProfile("Hagonoy", "Iba"),
    order: { delivery: "delivery", address: buyer("Hagonoy", "Iba") },
  });
  assert.equal(out.deliveryFee, 25);
  assert.equal(out.distanceKm, 0);
});

test("single: pickup has no fee and no distance", () => {
  const out = resolveDeliveryForOrder({
    farmerProfile: farmProfile("Hagonoy", "Iba"),
    order: { delivery: "pickup", address: null, deliveryFee: 35 },
  });
  assert.equal(out.deliveryFee, 0);
  assert.equal(out.distanceKm, 0);
});

test("single: legacy order without barangay keeps the written fee", () => {
  const out = resolveDeliveryForOrder({
    farmerProfile: { farmName: "Old Farm" },
    order: { delivery: "delivery", address: { street: "old" }, deliveryFee: 35, distanceKm: 5, deliveryTier: "legacy" },
  });
  assert.equal(out.legacy, true);
  assert.equal(out.deliveryFee, 35);
});

test("single: missing farm barangay throws FARM_MISSING_BARANGAY", () => {
  assert.throws(
    () =>
      resolveDeliveryForOrder({
        farmerProfile: { farmName: "No-barangay Farm" },
        order: { delivery: "delivery", address: buyer("Hagonoy", "Iba") },
      }),
    (e) => e.code === "FARM_MISSING_BARANGAY"
  );
});

test("batch: SJDM + Baliwag quotes resolve mixed never-rejecting", () => {
  const out = resolveDeliveryBatch({
    pairs: [
      { key: "f1", farmerId: "f1", farmerLocation: { city: "San Jose del Monte", barangay: "Sapang Palay", province: "Bulacan" } },
      { key: "f2", farmerId: "f2", farmerLocation: { city: "Baliwag", barangay: "Poblacion", province: "Bulacan" } },
    ],
    buyerLocation: buyer("Hagonoy", "Iba"),
  });
  assert.equal(out.length, 2);
  for (const r of out) {
    assert.equal(r.success, true);
    assert.ok(Number(r.deliveryFee) > 0);
    assert.ok(Number(r.distanceKm) > 0);
  }
});

test("batch without buyer barangay fails every farm with ADDRESS_MISSING_BARANGAY", () => {
  const out = resolveDeliveryBatch({
    pairs: [{ key: "f1", farmerId: "f1", farmerLocation: { city: "Hagonoy", barangay: "Iba" } }],
    buyerLocation: null,
  });
  assert.equal(out[0].success, false);
  assert.equal(out[0].code, "ADDRESS_MISSING_BARANGAY");
});

test("batch without farm barangay fails with FARM_MISSING_BARANGAY", () => {
  const out = resolveDeliveryBatch({
    pairs: [{ key: "f1", farmerId: "f1", farmerLocation: null }],
    buyerLocation: buyer("Hagonoy", "Iba"),
  });
  assert.equal(out[0].success, false);
  assert.equal(out[0].code, "FARM_MISSING_BARANGAY");
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
