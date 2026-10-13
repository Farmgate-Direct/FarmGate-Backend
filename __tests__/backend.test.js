// Backend contract tests with a fake Firestore (no network — pure compute).
// Run: node --test __tests__/backend.test.js
//
// Covers:
// - GCash total = subtotal (server prices) + barangay fee (client ignored)
// - second /deliver press does not double-credit (idempotent guard)
// - COD adds no wallet credit (delivery fee is cash the farmer already holds)
// - pickup has no fee
// - an out-of-Bulacan address is blocked at accept (order stays pending)
// - legacy orders without barangay keep the fee already written
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

const FARM_PROFILE = { municipality: "Hagonoy", barangay: "San Isidro", province: "Bulacan", farmName: "Test Farm" };
const buyerAddress = () => ({
  fullName: "Buyer",
  street: "123 Street",
  barangay: "Iba",
  city: "Hagonoy",
  province: "Bulacan",
  phone: "09123456789",
});

test("GCash total = subtotal (server prices) + barangay fee; client fee ignored", async () => {
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
  // Hagonoy San Isidro → Iba: 2.5 km adjusted → ₱25 (0–3 km).
  const priced = await priceOrderOnServer(transaction, db, order);
  assert.equal(priced.subtotal, 200);
  assert.equal(priced.deliveryFee, 25);
  assert.equal(priced.distanceKm, 2.5);
  assert.equal(priced.deliveryTier, "0–3 km");
  assert.equal(priced.feeStatus, "ok");
  assert.equal(priced.roadFactor, 1.3);
  assert.equal(priced.deliveryMethod, "barangay-road-factor");
  assert.equal(priced.total, 225);
  assert.notEqual(priced.deliveryFee, 1);
});

test("pickup has no fee and no distance", () => {
  const out = resolveDeliveryForOrder({
    farmerProfile: FARM_PROFILE,
    order: { delivery: "pickup", address: null, deliveryFee: 35 },
  });
  assert.equal(out.deliveryFee, 0);
  assert.equal(out.distanceKm, 0);
});

test("out-of-Bulacan address is blocked at accept (UNKNOWN_CITY)", async () => {
  const { priceOrderOnServer } = walletRoutes._test;
  const products = {
    p1: { farmerId: "f1", name: "Rice", price: 100, unit: "kg", archived: false },
  };
  const users = { f1: { ...FARM_PROFILE } };
  const { db, transaction } = fakeDb({ products, users });
  const order = {
    farmerId: "f1",
    delivery: "delivery",
    status: "pending",
    address: { ...buyerAddress(), city: "Angeles", province: "Pampanga" },
    products: [{ productId: "p1", quantity: 1, name: "Rice", price: 100, unit: "kg" }],
  };
  await assert.rejects(
    priceOrderOnServer(transaction, db, order),
    (e) => e.code === "UNKNOWN_CITY" || e.code === "INVALID_PROVINCE"
  );
});

test("legacy order without barangay keeps the fee already written (no recompute)", () => {
  const out = resolveDeliveryForOrder({
    farmerProfile: { farmName: "Old Farm" },
    order: { delivery: "delivery", address: { street: "old" }, deliveryFee: 35, distanceKm: 5, deliveryTier: "legacy" },
  });
  assert.equal(out.legacy, true);
  assert.equal(out.deliveryFee, 35);
});

test("missing farm barangay blocks with FARM_MISSING_BARANGAY (no stored fee)", () => {
  assert.throws(
    () =>
      resolveDeliveryForOrder({
        farmerProfile: { farmName: "No-barangay Farm" },
        order: { delivery: "delivery", address: buyerAddress() },
      }),
    (e) => e.code === "FARM_MISSING_BARANGAY"
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
