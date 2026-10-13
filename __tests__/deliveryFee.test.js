// Unit tests for deliveryFee (barangay quotes, exact-name matching).
// Run: node --test __tests__/deliveryFee.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DeliveryFeeError,
  quoteDeliveryFee,
  lookupBarangay,
  farmLocationFromProfile,
  buyerLocationFromAddress,
  FEE_TIERS,
} = require("../deliveryFee");

const farm = (city, barangay, province = "Bulacan") => ({ province, city, barangay });
const buyer = (city, barangay, province = "Bulacan") => ({ province, city, barangay });

test("same barangay: 0 km, ₱25", () => {
  const q = quoteDeliveryFee(
    farm("Hagonoy", "San Isidro"),
    buyer("Hagonoy", "San Isidro")
  );
  assert.equal(q.distanceKm, 0);
  assert.equal(q.deliveryFee, 25);
  assert.equal(q.tier, "0–3 km");
  assert.equal(q.feeStatus, "ok");
});

test("same barangay matches despite case/whitespace", () => {
  const q = quoteDeliveryFee(
    farm("  hagonoy ", "SAN ISIDRO"),
    buyer("Hagonoy", "San Isidro")
  );
  assert.equal(q.distanceKm, 0);
  assert.equal(q.deliveryFee, 25);
});

test("same city, close barangays: computed distance, NOT 0 km", () => {
  // Hagonoy San Isidro → Iba: 1.89 km straight × 1.3 = 2.5 km → ₱25 tier
  // (same tier as base, but a genuinely computed 2.5 km, not a shortcut).
  const q = quoteDeliveryFee(farm("Hagonoy", "San Isidro"), buyer("Hagonoy", "Iba"));
  assert.equal(q.distanceKm, 2.5);
  assert.equal(q.adjustedDistanceKm, 2.5);
  assert.equal(q.deliveryFee, 25);
  assert.equal(q.roadFactor, 1.3);
});

test("same city, far apart (SJDM Sapang Palay → Muzon): computed tier", () => {
  const q = quoteDeliveryFee(
    farm("San Jose del Monte", "Sapang Palay"),
    buyer("San Jose del Monte", "Muzon")
  );
  assert.ok(q.distanceKm > 3, `got ${q.distanceKm}`);
  assert.equal(q.deliveryFee, 50);
  assert.equal(q.tier, "6.1–10 km");
});

test("same city, far apart (Norzagaray Poblacion → Bigte): computed tier", () => {
  const q = quoteDeliveryFee(
    farm("Norzagaray", "Poblacion"),
    buyer("Norzagaray", "Bigte")
  );
  assert.ok(q.distanceKm > 3, `got ${q.distanceKm}`);
  assert.equal(q.deliveryFee, 50);
  assert.equal(q.tier, "6.1–10 km");
});

test("different cities across the province (Malolos → San Miguel)", () => {
  const q = quoteDeliveryFee(
    farm("Malolos", "Santo Niño (Pob.)"),
    buyer("San Miguel", "Poblacion")
  );
  assert.ok(q.distanceKm > 20, `got ${q.distanceKm}`);
  assert.equal(q.deliveryFee, 100);
  assert.equal(q.tier, "20.1 km+");
});

test("non-Bulacan province is blocked (INVALID_PROVINCE)", () => {
  assert.throws(
    () => quoteDeliveryFee(farm("Hagonoy", "Iba", "Pampanga"), buyer("Hagonoy", "Iba")),
    (e) => e instanceof DeliveryFeeError && e.code === "INVALID_PROVINCE"
  );
  assert.throws(
    () => quoteDeliveryFee(farm("Hagonoy", "Iba"), buyer("Hagonoy", "Iba", "Metro Manila")),
    (e) => e instanceof DeliveryFeeError && e.code === "INVALID_PROVINCE"
  );
});

test("unknown city is blocked (UNKNOWN_CITY)", () => {
  assert.throws(
    () => quoteDeliveryFee(farm("Hagonoy City", "Iba"), buyer("Hagonoy", "Iba")),
    (e) => e instanceof DeliveryFeeError && e.code === "UNKNOWN_CITY"
  );
});

test("typo in barangay is blocked (UNKNOWN_BARANGAY, no fuzzy)", () => {
  assert.throws(
    () => quoteDeliveryFee(farm("Hagonoy", "Iba"), buyer("Hagonoy", "Ibaa")),
    (e) => e instanceof DeliveryFeeError && e.code === "UNKNOWN_BARANGAY"
  );
});

test("same barangay name in two cities resolves per-city (Iba)", () => {
  const hagonoy = lookupBarangay("Hagonoy", "Iba");
  const meycauayan = lookupBarangay("Meycauayan", "Iba");
  assert.ok(hagonoy && meycauayan);
  assert.notDeepEqual(hagonoy, meycauayan);
  // Meycauayan Iba → Hagonoy Iba is a long cross-province trip (₱100).
  const q = quoteDeliveryFee(farm("Meycauayan", "Iba"), buyer("Hagonoy", "Iba"));
  assert.ok(q.distanceKm > 20, `got ${q.distanceKm}`);
  assert.equal(q.deliveryFee, 100);
});

test("missing farm barangay throws FARM_MISSING_BARANGAY", () => {
  assert.throws(
    () => quoteDeliveryFee({ city: "", barangay: "" }, buyer("Hagonoy", "Iba")),
    (e) => e instanceof DeliveryFeeError && e.code === "FARM_MISSING_BARANGAY"
  );
});

test("farm location prefers municipality, falls back to city", () => {
  assert.deepEqual(
    farmLocationFromProfile({ municipality: "Hagonoy", city: "X", barangay: "Iba", province: "Bulacan" }),
    { province: "Bulacan", city: "Hagonoy", barangay: "Iba" }
  );
  assert.deepEqual(
    farmLocationFromProfile({ city: "Hagonoy", barangay: "Iba" }),
    { province: "", city: "Hagonoy", barangay: "Iba" }
  );
  assert.equal(farmLocationFromProfile({ farmName: "No barangay" }), null);
});

test("buyer location reads city/barangay text (never coords)", () => {
  assert.deepEqual(
    buyerLocationFromAddress({ city: "Malolos", barangay: "Tikay", lat: 1, lng: 2 }),
    { province: "", city: "Malolos", barangay: "Tikay" }
  );
  assert.equal(buyerLocationFromAddress({ city: "Malolos" }), null);
});

test("rate table is data (array), not an if-else chain", () => {
  assert.ok(Array.isArray(FEE_TIERS));
  assert.equal(FEE_TIERS.length, 6);
});
