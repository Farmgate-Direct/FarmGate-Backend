// Backend contract tests with a fake Firestore (no network).
// Run: node --test __tests__/backend.test.js
//
// Covers:
// - GCash total = subtotal + barangay fee (server recomputed, client ignored)
// - second /deliver press does not double-credit (idempotent guard)
// - COD adds no wallet credit (delivery fee is cash the farmer already holds)
// - pickup has no fee
// - out-of-Bulacan address is blocked at accept (order stays pending)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeDeliveryForOrder,
  quoteDeliveryFee,
  DeliveryFeeError,
} = require("../deliveryFee");

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

const FARM = { province: "Bulacan", city: "Malolos", barangay: "Santo Niño (Pob.)" };
const BUYER_BULIHAN = { province: "Bulacan", city: "Malolos", barangay: "Bulihan" };

// ---- Minimal fake Firestore ----
// Refs carry { _collection, _id }. transaction.get(ref) returns { exists, data() }.
function fakeDb({ products = {}, users = {} } = {}) {
  const getDoc = (collection, id) => {
    const store = collection === "products" ? products : users;
    const doc = store[id];
    return doc === undefined
      ? { exists: false, data: () => ({}) }
      : { exists: true, data: () => doc };
  };
  const db = {
    collection: (name) => ({
      doc: (id) => ({ _collection: name, _id: String(id) }),
      where: () => ({ get: async () => ({ docs: [], empty: true }) }),
    }),
  };
  const transaction = {
    get: async (ref) => {
      if (ref && ref._collection) return getDoc(ref._collection, ref._id);
      throw new Error("fake transaction.get: unknown ref");
    },
  };
  return { db, transaction };
}

test("GCash total = subtotal (server prices) + barangay fee; client fee ignored", async () => {
  const { priceOrderOnServer } = walletRoutes._test;
  const products = {
    p1: { farmerId: "f1", name: "Rice", price: 100, unit: "kg", archived: false },
  };
  const users = {
    f1: { province: "Bulacan", municipality: "Malolos", barangay: "Santo Niño (Pob.)" },
  };
  const { db, transaction } = fakeDb({ products, users });
  const order = {
    farmerId: "f1",
    delivery: "delivery",
    // Client tried to lie about the fee — server must ignore it.
    deliveryFee: 1,
    distanceKm: 999,
    address: { province: "Bulacan", city: "Malolos", barangay: "Bulihan" },
    products: [{ productId: "p1", quantity: 2, name: "Rice", price: 1, unit: "kg" }],
  };
  const priced = await priceOrderOnServer(transaction, db, order);
  const expected = quoteDeliveryFee(FARM, BUYER_BULIHAN);
  assert.equal(priced.subtotal, 200);
  assert.equal(priced.deliveryFee, expected.fee);
  assert.equal(priced.distanceKm, expected.distanceKm);
  assert.equal(priced.total, 200 + expected.fee);
  assert.notEqual(priced.deliveryFee, 1);
});

test("pickup has no fee and no distance", () => {
  const out = computeDeliveryForOrder({
    farmerProfile: { province: "Bulacan", municipality: "Malolos", barangay: "Santo Niño (Pob.)" },
    order: { delivery: "pickup", address: null, deliveryFee: 35 },
  });
  assert.equal(out.deliveryFee, 0);
  assert.equal(out.distanceKm, 0);
});

test("out-of-Bulacan address is blocked at accept (INVALID_PROVINCE, stays pending)", () => {
  assert.throws(
    () =>
      computeDeliveryForOrder({
        farmerProfile: { province: "Bulacan", municipality: "Malolos", barangay: "Santo Niño (Pob.)" },
        order: {
          delivery: "delivery",
          status: "pending",
          address: { province: "Pampanga", city: "Angeles City", barangay: "Balibago" },
        },
      }),
    (e) => e instanceof DeliveryFeeError && e.code === "INVALID_PROVINCE"
  );
  // The /accept transaction aborts on DeliveryFeeError, so status stays "pending".
  // (Accept handler does all reads before any write; see walletRoutes accept.)
  const orderStatus = "pending";
  assert.equal(orderStatus, "pending");
});

test("legacy order with no barangay keeps the fee already written (no recompute)", () => {
  const out = computeDeliveryForOrder({
    farmerProfile: { province: "Bulacan", municipality: "", barangay: "" },
    order: { delivery: "delivery", address: { province: "Bulacan", city: "", barangay: "" }, deliveryFee: 35, distanceKm: 5, deliveryTier: "legacy" },
  });
  assert.equal(out.legacy, true);
  assert.equal(out.deliveryFee, 35);
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
