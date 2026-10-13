// osrmClient tests with mocked fetch. No network, no estimates:
// every failure path must THROW (NO_ROUTE / UNAVAILABLE), never return a fee.
// Run: node --test __tests__/osrmClient.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { OsrmError, getRouteDistanceKm } = require("../osrmClient");

const FARM = { lat: 14.841, lng: 120.8107 };
const BUYER = { lat: 14.8298, lng: 120.8798 };
const silent = { info: () => {}, warn: () => {} };

const okFetch = (meters) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ code: "Ok", routes: [{ distance: meters }] }),
});

test("normal result: meters -> km rounded to 0.1", async () => {
  const r = await getRouteDistanceKm(FARM, BUYER, {
    fetchImpl: okFetch(6140),
    logger: silent,
    env: { OSRM_DATA_VERSION: "v1" },
  });
  assert.equal(r.distanceKm, 6.1);
  assert.equal(r.osrmDataVersion, "v1");
});

test("same pin: 0 km with ZERO fetch calls", async () => {
  let calls = 0;
  const r = await getRouteDistanceKm(FARM, { ...FARM }, {
    fetchImpl: async () => { calls += 1; return okFetch(100)(); },
    logger: silent,
  });
  assert.equal(r.distanceKm, 0);
  assert.equal(calls, 0);
});

test("NoRoute / NoSegment / empty routes -> NO_ROUTE (no retry, no estimate)", async () => {
  for (const body of [
    { code: "NoRoute", routes: [] },
    { code: "NoSegment", routes: [] },
    { code: "Ok", routes: [] },
  ]) {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => body };
    };
    await assert.rejects(
      getRouteDistanceKm(FARM, BUYER, { fetchImpl, logger: silent }),
      (e) => e instanceof OsrmError && e.code === "NO_ROUTE"
    );
    assert.equal(calls, 1, "NO_ROUTE must not retry");
  }
});

test("timeout then success on retry", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    return okFetch(4200)();
  };
  const r = await getRouteDistanceKm(FARM, BUYER, { fetchImpl, logger: silent, timeoutMs: 50 });
  assert.equal(r.distanceKm, 4.2);
  assert.equal(calls, 2);
});

test("timeout twice -> UNAVAILABLE (order stays pending, no estimate)", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  };
  await assert.rejects(
    getRouteDistanceKm(FARM, BUYER, { fetchImpl, logger: silent, timeoutMs: 20 }),
    (e) => e instanceof OsrmError && e.code === "UNAVAILABLE"
  );
  assert.equal(calls, 2, "exactly one retry");
});

test("malformed JSON -> retry, then UNAVAILABLE (never a fee)", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError("bad json"); },
  });
  await assert.rejects(
    getRouteDistanceKm(FARM, BUYER, { fetchImpl, logger: silent }),
    (e) => e instanceof OsrmError && e.code === "UNAVAILABLE"
  );
});

test("request URL shape: driving profile, lng,lat order, overview=false", async () => {
  let seen = "";
  const fetchImpl = async (url) => {
    seen = String(url);
    return okFetch(1000)();
  };
  await getRouteDistanceKm(FARM, BUYER, { fetchImpl, logger: silent, env: { OSRM_BASE_URL: "http://127.0.0.1:5000/" } });
  assert.ok(seen.startsWith("http://127.0.0.1:5000/route/v1/driving/"), seen);
  assert.ok(seen.includes("120.8107,14.841;120.8798,14.8298"), seen);
  assert.ok(seen.includes("overview=false"), seen);
});
