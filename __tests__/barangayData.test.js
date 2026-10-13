// Barangay dataset tests: exactly 569 entries, unique keys, valid coords.
// Run: node --test __tests__/barangayData.test.js
// (The builder enforces the same rules at build time; these guard regressions.)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { BARANGAY_COORDS, CITIES, BARANGAYS_BY_CITY } = require("../data/bulacanBarangays");

const BBOX = { minLat: 14.4, maxLat: 15.4, minLng: 120.5, maxLng: 121.4 };

test("dataset has exactly 569 barangays", () => {
  assert.equal(Object.keys(BARANGAY_COORDS).length, 569);
});

test("24 Bulacan cities/municipalities", () => {
  assert.equal(CITIES.length, 24);
  const listed = Object.values(BARANGAYS_BY_CITY).reduce((n, l) => n + l.length, 0);
  assert.equal(listed, 569);
});

test("no duplicate keys, every coordinate valid and inside Bulacan", () => {
  const keys = Object.keys(BARANGAY_COORDS);
  assert.equal(new Set(keys).size, 569);
  for (const key of keys) {
    const c = BARANGAY_COORDS[key];
    assert.ok(Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng)), key);
    assert.ok(
      c.lat >= BBOX.minLat && c.lat <= BBOX.maxLat &&
      c.lng >= BBOX.minLng && c.lng <= BBOX.maxLng,
      `${key} outside bbox`
    );
  }
});
