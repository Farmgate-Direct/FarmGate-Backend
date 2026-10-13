// Cache tests: sorted keys, version miss, 30-day expiry.
// Run: node --test __tests__/deliveryCache.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { cacheKeyFor, isFresh, readCache, writeCache, THIRTY_DAYS_MS } = require("../deliveryCache");

const A = { lat: 14.841, lng: 120.8107 };
const B = { lat: 14.8298, lng: 120.8798 };

// Minimal Firestore-shaped fake: collection().doc() with get/set.
function fakeDb(store = {}) {
  return {
    collection: (name) => ({
      doc: (id) => ({
        _collection: name,
        _id: String(id),
        get: async () =>
          store[`${name}/${id}`] === undefined
            ? { exists: false, data: () => ({}) }
            : { exists: true, data: () => store[`${name}/${id}`] },
        set: async (record) => { store[`${name}/${id}`] = record; },
      }),
    }),
  };
}

test("same pair in reverse order shares one key (cache hit)", async () => {
  assert.equal(cacheKeyFor(A, B, "v1"), cacheKeyFor(B, A, "v1"));
  const db = fakeDb();
  await writeCache(db, cacheKeyFor(A, B, "v1"), { distanceKm: 6.1, osrmDataVersion: "v1" });
  const hit = await readCache(db, cacheKeyFor(B, A, "v1"));
  assert.ok(hit);
  assert.equal(hit.distanceKm, 6.1);
});

test("new OSRM_DATA_VERSION misses the cache", async () => {
  const db = fakeDb();
  await writeCache(db, cacheKeyFor(A, B, "v1"), { distanceKm: 6.1, osrmDataVersion: "v1" });
  assert.notEqual(cacheKeyFor(A, B, "v1"), cacheKeyFor(A, B, "v2"));
  assert.equal(await readCache(db, cacheKeyFor(A, B, "v2")), null);
});

test("entries expire after 30 days", async () => {
  assert.equal(THIRTY_DAYS_MS, 30 * 24 * 60 * 60 * 1000);
  const now = Date.now();
  assert.equal(isFresh({ distanceKm: 1, cachedAt: now }, now), true);
  assert.equal(isFresh({ distanceKm: 1, cachedAt: now - THIRTY_DAYS_MS - 1000 }, now), false);
  // Firestore Timestamp shape also accepted.
  assert.equal(
    isFresh({ distanceKm: 1, cachedAt: { seconds: Math.floor(now / 1000), toMillis: () => now } }, now),
    true
  );
  const db = fakeDb({
    [`deliveryDistanceCache/${cacheKeyFor(A, B, "v1")}`]: {
      distanceKm: 6.1,
      cachedAt: now - THIRTY_DAYS_MS - 1000,
      osrmDataVersion: "v1",
      method: "osrm",
    },
  });
  assert.equal(await readCache(db, cacheKeyFor(A, B, "v1"), now), null);
});
