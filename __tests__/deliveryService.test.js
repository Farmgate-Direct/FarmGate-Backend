// deliveryService batch + rate-limit tests (mocked OSRM, fake cache db).
// Run: node --test __tests__/deliveryService.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveDeliveryBatch } = require("../deliveryService");
const { OsrmError } = require("../osrmClient");
const { checkQuoteRateLimit, resetQuoteRateLimits } = require("../quoteRateLimit");

function fakeDb(store = {}) {
  return {
    collection: (name) => ({
      doc: (id) => ({
        get: async () =>
          store[`${name}/${id}`] === undefined
            ? { exists: false, data: () => ({}) }
            : { exists: true, data: () => store[`${name}/${id}`] },
        set: async (record) => { store[`${name}/${id}`] = record; },
      }),
    }),
  };
}

const FARM_A = { lat: 14.841, lng: 120.8107 };
const FARM_B = { lat: 15.14, lng: 120.9771 };
const BUYER = { lat: 14.8298, lng: 120.8798 };

test("batch: one OK + one NO_ROUTE resolves mixed (never rejects)", async () => {
  const getDistanceKm = async (farm) => {
    if (farm.lat === FARM_B.lat) throw new OsrmError("NO_ROUTE", "No route.");
    return { distanceKm: 6.1, osrmDataVersion: "v-test" };
  };
  const out = await resolveDeliveryBatch({
    db: fakeDb(),
    pairs: [
      { key: "f1", farmerId: "f1", farmerPin: FARM_A },
      { key: "f2", farmerId: "f2", farmerPin: FARM_B },
    ],
    buyerPin: BUYER,
    getDistanceKm,
  });
  assert.equal(out.length, 2);
  const ok = out.find((r) => r.key === "f1");
  const bad = out.find((r) => r.key === "f2");
  assert.equal(ok.success, true);
  assert.equal(ok.deliveryFee, 50); // 6.1 km -> 5.1–10 km tier
  assert.equal(bad.success, false);
  assert.equal(bad.code, "NO_ROUTE");
});

test("batch without buyer pin fails every farm with ADDRESS_MISSING_PIN", async () => {
  const out = await resolveDeliveryBatch({
    db: fakeDb(),
    pairs: [{ key: "f1", farmerId: "f1", farmerPin: FARM_A }],
    buyerPin: null,
    getDistanceKm: async () => { throw new Error("must not be called"); },
  });
  assert.equal(out[0].success, false);
  assert.equal(out[0].code, "ADDRESS_MISSING_PIN");
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
