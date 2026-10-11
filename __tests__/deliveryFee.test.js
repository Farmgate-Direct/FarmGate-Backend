// Unit tests for deliveryFee (barangay-level, Bulacan only).
// Run: node --test __tests__/deliveryFee.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  quoteDeliveryFee,
  DeliveryFeeError,
  getRoadFactor,
} = require("../deliveryFee");

// Real verified rows from data/bulacanBarangays.js
const farmMalolosPob = {
  province: "Bulacan",
  city: "Malolos",
  barangay: "Santo Niño (Pob.)",
};
const buyerMalolosBulihan = {
  province: "Bulacan",
  city: "Malolos",
  barangay: "Bulihan",
};
const buyerGuiguintoPob = {
  province: "Bulacan",
  city: "Guiguinto",
  barangay: "Poblacion",
};

test("same barangay = 0 km, ₱25 (exact match, case/space-insensitive)", () => {
  const q = quoteDeliveryFee(
    { province: "  BULACAN ", city: " Malolos ", barangay: "Santo Niño (Pob.)" },
    { province: "bulacan", city: "malolos", barangay: "  santo niño (pob.) " }
  );
  assert.equal(q.distanceKm, 0);
  assert.equal(q.fee, 25);
});

test("adjacent barangays: Malolos Pob -> Bulihan is small non-zero distance, fee ₱25", () => {
  const q = quoteDeliveryFee(farmMalolosPob, buyerMalolosBulihan);
  assert.ok(q.distanceKm > 0 && q.distanceKm <= 3.0, `got ${q.distanceKm}`);
  assert.equal(q.fee, 25);
});

test("adjacent cities: Malolos Pob -> Guiguinto Poblacion costs more than intra-city", () => {
  const near = quoteDeliveryFee(farmMalolosPob, buyerMalolosBulihan);
  const far = quoteDeliveryFee(farmMalolosPob, buyerGuiguintoPob);
  assert.ok(far.distanceKm > near.distanceKm, `${far.distanceKm} vs ${near.distanceKm}`);
  assert.ok(far.fee >= near.fee);
});

test("tier boundary: 3.0 km = ₱25, 3.1 km = ₱35 (inclusive upper bounds)", () => {
  // Synthetic injection: farm at origin; buyers placed so road distance
  // (haversine × 1.3, rounded to 0.1) lands exactly on 3.0 and 3.1.
  // haversine needed: 3.0/1.3 = 2.30769 km; 3.1/1.3 = 2.38462 km.
  // At lat 14.8, 1 deg lat ≈ 110.6 km.
  const farm = { province: "Bulacan", city: "TestCity", barangay: "FarmBrgy" };
  const b30 = { province: "Bulacan", city: "TestCity", barangay: "Buyer30" };
  const b31 = { province: "Bulacan", city: "TestCity", barangay: "Buyer31" };
  const data = {
    "testcity|farmbrgy": { city: "TestCity", barangay: "FarmBrgy", lat: 14.8, lng: 120.81 },
    "testcity|buyer30": { city: "TestCity", barangay: "Buyer30", lat: 14.8 + 2.30769 / 110.6, lng: 120.81 },
    "testcity|buyer31": { city: "TestCity", barangay: "Buyer31", lat: 14.8 + 2.38462 / 110.6, lng: 120.81 },
  };
  const q30 = quoteDeliveryFee(farm, b30, { data, roadFactor: 1.3 });
  const q31 = quoteDeliveryFee(farm, b31, { data, roadFactor: 1.3 });
  assert.equal(q30.distanceKm, 3.0);
  assert.equal(q30.fee, 25);
  assert.equal(q31.distanceKm, 3.1);
  assert.equal(q31.fee, 35);
});

test("non-Bulacan province is blocked with INVALID_PROVINCE", () => {
  assert.throws(
    () =>
      quoteDeliveryFee(
        farmMalolosPob,
        { province: "Pampanga", city: "Angeles City", barangay: "Balibago" }
      ),
    (e) => e instanceof DeliveryFeeError && e.code === "INVALID_PROVINCE"
  );
});

test("typo in barangay name is UNKNOWN_BARANGAY (no fuzzy match)", () => {
  assert.throws(
    () =>
      quoteDeliveryFee(farmMalolosPob, {
        province: "Bulacan",
        city: "Malolos",
        barangay: "Santo Nino (Pob)", // missing ñ + period -> typo
      }),
    (e) => e instanceof DeliveryFeeError && e.code === "UNKNOWN_BARANGAY"
  );
});

test("same barangay name in another city resolves by (city, barangay) key", () => {
  // "San Agustin" exists in both Hagonoy and Malolos — different places,
  // so the same farm must quote DIFFERENT distances (never confused).
  const hagonoyPob = { province: "Bulacan", city: "Hagonoy", barangay: "Santo Niño (Pob.)" };
  const hagonoyAgustin = { province: "Bulacan", city: "Hagonoy", barangay: "San Agustin" };
  const malolosAgustin = { province: "Bulacan", city: "Malolos", barangay: "San Agustin" };
  const dSameCity = quoteDeliveryFee(hagonoyPob, hagonoyAgustin);
  const dCrossCity = quoteDeliveryFee(hagonoyPob, malolosAgustin);
  assert.ok(dSameCity.distanceKm > 0);
  assert.ok(dCrossCity.distanceKm > 0);
  assert.notEqual(dSameCity.distanceKm, dCrossCity.distanceKm);
  // And a typo'd variant of a real name is still UNKNOWN_BARANGAY (no fuzzy).
  assert.throws(
    () =>
      quoteDeliveryFee(hagonoyPob, {
        province: "Bulacan",
        city: "Hagonoy",
        barangay: "San Agustinn",
      }),
    (e) => e instanceof DeliveryFeeError && e.code === "UNKNOWN_BARANGAY"
  );
});

test("unknown city is blocked with UNKNOWN_CITY", () => {
  assert.throws(
    () =>
      quoteDeliveryFee(farmMalolosPob, {
        province: "Bulacan",
        city: "Quezon City",
        barangay: "Commonwealth",
      }),
    (e) => e instanceof DeliveryFeeError && e.code === "UNKNOWN_CITY"
  );
});

test("road factor env: default 1.3, clamped to [1,2]", () => {
  assert.equal(getRoadFactor({}), 1.3);
  assert.equal(getRoadFactor({ FARMGATE_ROAD_DISTANCE_FACTOR: "1.5" }), 1.5);
  assert.equal(getRoadFactor({ FARMGATE_ROAD_DISTANCE_FACTOR: "99" }), 1.3);
  assert.equal(getRoadFactor({ FARMGATE_ROAD_DISTANCE_FACTOR: "0.5" }), 1.3);
  assert.equal(getRoadFactor({ FARMGATE_ROAD_DISTANCE_FACTOR: "abc" }), 1.3);
});
