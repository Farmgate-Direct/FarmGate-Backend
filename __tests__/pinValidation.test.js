// Pin validation tests: Bulacan bbox + numeric ranges.
// Run: node --test __tests__/pinValidation.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { validatePin, hasPin, BULACAN_BBOX, DeliveryFeeError } = require("../deliveryFee");

test("bbox matches the OSM extract box", () => {
  assert.deepEqual(BULACAN_BBOX, { minLat: 14.4, maxLat: 15.4, minLng: 120.5, maxLng: 121.4 });
});

test("inside pins pass through as numbers", () => {
  assert.deepEqual(validatePin({ lat: "14.841", lng: "120.8107" }), { lat: 14.841, lng: 120.8107 });
  assert.deepEqual(validatePin({ lat: 15.4, lng: 121.4 }), { lat: 15.4, lng: 121.4 }); // edge inclusive
});

test("outside the Bulacan bbox is rejected (PIN_OUT_OF_AREA)", () => {
  // NOTE: the bbox (14.4–15.4, 120.5–121.4) generously covers Metro Manila,
  // so use points truly outside it.
  for (const pin of [
    { lat: 14.83, lng: 120.28 }, // Olongapo side (west of minLng)
    { lat: 15.48, lng: 120.59 }, // Tarlac side (north of maxLat)
    { lat: 13.76, lng: 121.06 }, // Batangas side (south of minLat)
    { lat: 14.39, lng: 120.9 }, // just below minLat
    { lat: 14.9, lng: 121.41 }, // just above maxLng
  ]) {
    assert.throws(
      () => validatePin(pin),
      (e) => e instanceof DeliveryFeeError && e.code === "PIN_OUT_OF_AREA",
      JSON.stringify(pin)
    );
  }
});

test("non-numeric or out-of-range values rejected (INVALID_PIN)", () => {
  for (const pin of [
    null, undefined, {}, { lat: "", lng: "" },
    { lat: "abc", lng: 120.8 }, { lat: 14.8, lng: "x" },
    { lat: 91, lng: 120.8 }, { lat: 14.8, lng: 181 },
  ]) {
    assert.throws(
      () => validatePin(pin),
      (e) => e instanceof DeliveryFeeError && e.code === "INVALID_PIN",
      JSON.stringify(pin)
    );
  }
});

test("hasPin guards missing coordinates", () => {
  assert.equal(hasPin({ lat: 14.8, lng: 120.8 }), true);
  assert.equal(hasPin(null), false);
  assert.equal(hasPin({}), false);
  assert.equal(hasPin({ lat: 14.8 }), false);
});
