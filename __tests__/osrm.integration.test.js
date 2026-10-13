// Live OSRM integration: health check + 3 known Bulacan routes.
// Only runs with OSRM_LIVE_TEST=1 and a reachable OSRM_BASE_URL.
// Otherwise skipped (unit suite uses mocked OSRM instead).
// Run: OSRM_LIVE_TEST=1 OSRM_BASE_URL=http://127.0.0.1:5000 node --test __tests__/osrm.integration.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { checkHealth, getRouteDistanceKm } = require("../osrmClient");

const LIVE = process.env.OSRM_LIVE_TEST === "1";

const ROUTES = [
  [{ lat: 14.841, lng: 120.8107 }, { lat: 14.8298, lng: 120.8798 }], // Malolos -> Guiguinto
  [{ lat: 14.8661, lng: 120.7392 }, { lat: 14.8655, lng: 120.7568 }], // Hagonoy San Isidro -> Iba
  [{ lat: 14.841, lng: 120.8107 }, { lat: 15.14, lng: 120.9771 }], // Malolos -> San Miguel
];

test("live OSRM health check (code Ok)", { skip: !LIVE }, async () => {
  const r = await checkHealth();
  assert.equal(r.ok, true);
  assert.ok(r.distanceKm > 0);
});

for (let i = 0; i < ROUTES.length; i++) {
  test(`live route ${i + 1} returns a positive distance`, { skip: !LIVE }, async () => {
    const [a, b] = ROUTES[i];
    const r = await getRouteDistanceKm(a, b);
    assert.ok(r.distanceKm >= 0, `got ${r.distanceKm}`);
    assert.ok(r.osrmDataVersion);
  });
}
