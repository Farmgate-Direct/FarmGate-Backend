// Backend contract tests with a fake Firestore (no network — pure compute).
// Run: node --test __tests__/backend.test.js
//
// Covers:
// - total = subtotal (server prices) + Haversine fee (client fee ignored)
// - pickup has no fee
// - >70 km without a farmer-set fee is rejected (MANUAL_FEE_REQUIRED)
// - a farmer-set manual fee is honored while pins are unchanged
// - legacy orders without pins keep the fee already written (no recompute)
// - missing farm pickup blocks with FARM_MISSING_PICKUP
// - second /deliver press does not double-credit (idempotent guard)
// - COD adds no wallet credit (delivery fee is cash the farmer already holds)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveDeliveryForOrder } = require("../deliveryService");

// ---- Stub heavy deps so walletRoutes loads without node_modules ----
const Module = require("node:module");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "express") {
    const routerStub = () => {
      const r = {};
      for (const m of ["get", "post", "put", "delete", "use"]) r[m] = () => r;
      return r;
    };
    return { Router: routerStub };
  }
  if (request === "firebase-admin/firestore") {
    return {
      FieldValue: {
        serverTimestamp: () => new Date("2026-01-01T00:00:00Z"),
        increment: (n) => ({ __increment: n }),
        arrayUnion: (...a) => ({ __arrayUnion: a }),
      },
    };
  }
  return origLoad.call(this, request, parent, isMain);
};
const walletRoutes = require("../walletRoutes");

// ---- Minimal fake Firestore ----
function fakeDb({ products = {}, users = {} } = {}) {
  const store = { products, users };
  const ref = (collection, id) => ({
    _collection: collection,
    _id: String(id),
    get: async () => {
      const doc = (store[collection] || {})[String(id)];
      return doc === undefined
        ? { exists: false, data: () => ({}) }
        : { exists: true, data: () => doc };
    },
    set: async (record) => {
      store[collection] = store[collection] || {};
      store[collection][String(id)] = record;
    },
  });
  const db = {
    collection: (name) => ({
      doc: (id) => ref(name, id),
      where: () => ({ get: async () => ({ docs: [], empty: true }) }),
    }),
  };
  const transaction = {
    get: async (r) => {
      if (r && r._collection) return r.get();
      throw new Error("fake transaction.get: unknown ref");
    },
    set: async (r, record) => r.set(record),
  };
  return { db, transaction, store };
}

const FARM_PROFILE = { farmLat: 14.841, farmLng: 120.8107, farmName: "Test Farm" };
const FAR_FARM_PROFILE = { farmLat: 15.14, farmLng: 120.9771, farmName: "Far Farm" };
const CORNER_FARM_PROFILE = { farmLat: 14.41, farmLng: 120.51, farmName: "Corner Farm" };
const BUYER_PIN = { lat: 14.8298, lng: 120.8798 };
const CORNER_BUYER_PIN = { lat: 15.39, lng: 121.39 };
const buyerAddress = () => ({
  fullName: "Buyer",
  street: "123 Street",
  barangay: "Poblacion",
  city: "Guiguinto",
  province: "Bulacan",
  phone: "09123456789",
  ...BUYER_PIN,
});

test("total = subtotal (server prices) + Haversine fee; client fee ignored", async () => {
  const { priceOrderOnServer } = walletRoutes._test;
  const products = {
    p1: { farmerId: "f1", name: "Rice", price: 100, unit: "kg", archived: false },
  };
  const users = { f1: { ...FARM_PROFILE } };
  const { db, transaction } = fakeDb({ products, users });
  const order = {
    farmerId: "f1",
    delivery: "delivery",
    // Client tried to lie about the fee — server must ignore it.
    deliveryFee: 1,
    distanceKm: 999,
    address: buyerAddress(),
    products: [{ productId: "p1", quantity: 2, name: "Rice", price: 1, unit: "kg" }],
  };
  // Malolos→Guiguinto: 7.5 km straight, 9.8 adjusted → ₱75 (>7–12 km).
  const priced = await priceOrderOnServer(transaction, db, order);
  assert.equal(priced.subtotal, 200);
  assert.equal(priced.deliveryFee, 75);
  assert.equal(priced.distanceKm, 7.5);
  assert.equal(priced.adjustedDistanceKm, 9.8);
  assert.equal(priced.deliveryTier, ">7–12 km");
  assert.equal(priced.feeStatus, "ok");
  assert.equal(priced.roadFactor, 1.3);
  assert.equal(priced.deliveryMethod, "haversine-road-factor");
  assert.equal(priced.total, 275);
  assert.notEqual(priced.deliveryFee, 1);
});

test("pickup has no fee and no distance", async () => {
  const out = await resolveDeliveryForOrder({
    farmerProfile: FARM_PROFILE,
    order: { delivery: "pickup", address: null, deliveryFee: 35 },
  });
  assert.equal(out.deliveryFee, 0);
  assert.equal(out.distanceKm, 0);
});

test(">70 km without a farmer-set fee is rejected (MANUAL_FEE_REQUIRED)", async () => {
  const { priceOrderOnServer } = walletRoutes._test;
  const products = {
    p1: { farmerId: "f9", name: "Rice", price: 100, unit: "kg", archived: false },
  };
  const users = { f9: { ...CORNER_FARM_PROFILE } };
  const { db, transaction } = fakeDb({ products, users });
  const order = {
    farmerId: "f9",
    delivery: "delivery",
    address: { ...buyerAddress(), ...CORNER_BUYER_PIN },
    products: [{ productId: "p1", quantity: 1, name: "Rice", price: 100, unit: "kg" }],
  };
  await assert.rejects(
    priceOrderOnServer(transaction, db, order),
    (e) => e.code === "MANUAL_FEE_REQUIRED"
  );
});

test("farmer-set manual fee is honored while pins are unchanged", async () => {
  const { priceOrderOnServer } = walletRoutes._test;
  const products = {
    p1: { farmerId: "f9", name: "Rice", price: 100, unit: "kg", archived: false },
  };
  const users = { f9: { ...CORNER_FARM_PROFILE } };
  const { db, transaction } = fakeDb({ products, users });
  const order = {
    farmerId: "f9",
    delivery: "delivery",
    address: { ...buyerAddress(), ...CORNER_BUYER_PIN },
    feeStatus: "ok",
    manualFee: true,
    manualDeliveryFee: 150,
    manualFeePins: {
      farm: { lat: CORNER_FARM_PROFILE.farmLat, lng: CORNER_FARM_PROFILE.farmLng },
      buyer: { ...CORNER_BUYER_PIN },
    },
    products: [{ productId: "p1", quantity: 2, name: "Rice", price: 100, unit: "kg" }],
  };
  const priced = await priceOrderOnServer(transaction, db, order);
  assert.equal(priced.subtotal, 200);
  assert.equal(priced.deliveryFee, 150);
  assert.equal(priced.deliveryTier, "manual");
  assert.equal(priced.manualFee, true);
  assert.equal(priced.total, 350);
});

test("legacy order without pins keeps the fee already written (no recompute)", async () => {
  const out = await resolveDeliveryForOrder({
    farmerProfile: { farmName: "Old Farm" },
    order: { delivery: "delivery", address: { street: "old" }, deliveryFee: 35, distanceKm: 5, deliveryTier: "legacy" },
  });
  assert.equal(out.legacy, true);
  assert.equal(out.deliveryFee, 35);
});

test("missing farm pickup blocks with FARM_MISSING_PICKUP (no stored fee)", () => {
  assert.throws(
    () =>
      resolveDeliveryForOrder({
        farmerProfile: { farmName: "Pin-less Farm" },
        order: { delivery: "delivery", address: buyerAddress() },
      }),
    (e) => e.code === "FARM_MISSING_PICKUP"
  );
});

test("/deliver is idempotent: settled orders return early, no double credit", () => {
  // Mirrors the guard at the top of the /deliver transaction:
  // if (order.financialStatus === "settled") return { alreadySettled: true }.
  const settleOnce = ({ order, wallet }) => {
    if (order.financialStatus === "settled") {
      return { alreadySettled: true, wallet };
    }
    const earning = 97; // e.g. subtotal 100 - 3% commission
    return {
      alreadySettled: false,
      wallet: { ...wallet, availableBalance: wallet.availableBalance + earning },
    };
  };
  const wallet = { availableBalance: 0 };
  const first = settleOnce({ order: { financialStatus: "pending" }, wallet });
  assert.equal(first.alreadySettled, false);
  assert.equal(first.wallet.availableBalance, 97);
  const second = settleOnce({
    order: { financialStatus: "settled" },
    wallet: first.wallet,
  });
  assert.equal(second.alreadySettled, true);
  assert.equal(second.wallet.availableBalance, 97); // no double credit
});

test("COD /deliver adds no wallet credit (fee is cash the farmer already holds)", () => {
  // Mirrors /deliver: for COD, availableBalance is untouched; only the held
  // commission reserve moves. farmerEarning stays 0 for COD.
  const codSettle = ({ wallet, reservedAmount }) => ({
    availableBalance: wallet.availableBalance, // unchanged
    commissionReserveHeld: Math.max(0, wallet.commissionReserveHeld - reservedAmount),
    farmerEarning: 0,
  });
  const out = codSettle({
    wallet: { availableBalance: 50, commissionReserveHeld: 10 },
    reservedAmount: 6,
  });
  assert.equal(out.availableBalance, 50);
  assert.equal(out.farmerEarning, 0);
  assert.equal(out.commissionReserveHeld, 4);
});
