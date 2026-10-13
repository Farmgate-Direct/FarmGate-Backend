// Lists farms AND buyer addresses that still need a map pin.
// Delivery stays BLOCKED for these until the user sets a pin
// (Farm Profile / address setup, OSM picker, Bulacan bbox only).
// Old orders that already have a fee keep the written fee (no recompute).
//
// Usage:
//   node scripts/list-missing-pins.js
//
// Requires the same Firebase Admin env as index.js:
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
"use strict";
require("dotenv").config();
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const hasPin = (lat, lng) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));

async function main() {
  const projectId = (process.env.FIREBASE_PROJECT_ID || "").trim();
  const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "")
    .replace(/\\n/g, "\n")
    .trim();
  if (!projectId || !clientEmail || !privateKey) {
    console.error("Firebase Admin credentials are incomplete.");
    process.exit(1);
  }
  const app =
    getApps().length > 0
      ? getApps()[0]
      : initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  const db = getFirestore(app);

  const farmers = await db.collection("users").where("role", "==", "farmer").get();
  const farmsMissing = [];
  for (const doc of farmers.docs) {
    const u = doc.data() || {};
    if (!hasPin(u.farmLat ?? u.lat, u.farmLng ?? u.lng)) {
      farmsMissing.push({
        farmerId: doc.id,
        farmName: u.farmName || "(no farm name)",
        email: u.email || "",
      });
    }
  }
  console.log(`Farmers checked: ${farmers.size}`);
  console.log(`Farms missing pins: ${farmsMissing.length}`);
  for (const m of farmsMissing) {
    console.log(`- farm ${m.farmerId} | ${m.farmName} | ${m.email}`);
  }

  const addresses = await db.collection("addresses").get();
  let addrMissing = 0;
  for (const doc of addresses.docs) {
    const a = doc.data() || {};
    if (!hasPin(a.lat, a.lng)) {
      addrMissing += 1;
      console.log(`- address ${doc.id} | user ${a.userId || "?"} | ${a.city || ""} ${a.barangay || ""}`);
    }
  }
  console.log(`Addresses checked: ${addresses.size}, missing pins: ${addrMissing}`);

  if (farmsMissing.length > 0 || addrMissing > 0) {
    console.log(
      "\nMigration: farmers open Farm Profile and drop their pin; buyers open the address and set the pin. Delivery stays blocked until then. Old orders are untouched."
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
