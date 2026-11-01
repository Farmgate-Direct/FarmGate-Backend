"use strict";

require("dotenv").config();

const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const validAmount = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
};

async function main() {
  const projectId = (process.env.FIREBASE_PROJECT_ID || "").trim();
  const clientEmail = (process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "")
    .replace(/\\n/g, "\n")
    .trim();

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Firebase Admin credentials are incomplete. Check FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY."
    );
  }

  const app =
    getApps().length > 0
      ? getApps()[0]
      : initializeApp({
          credential: cert({ projectId, clientEmail, privateKey }),
        });
  const db = getFirestore(app);
  const apply = process.argv.includes("--apply");
  const [productsSnapshot, batchesSnapshot] = await Promise.all([
    db.collection("products").get(),
    db.collection("productBatches").get(),
  ]);
  const batchesByProduct = new Map();

  for (const batch of batchesSnapshot.docs) {
    const data = batch.data() || {};
    const productId = String(data.productId || "");
    if (!productId) continue;
    const batches = batchesByProduct.get(productId) || [];
    batches.push({ id: batch.id, ...data });
    batchesByProduct.set(productId, batches);
  }

  let migrated = 0;
  let skipped = 0;
  for (const productSnapshot of productsSnapshot.docs) {
    const product = productSnapshot.data() || {};
    if (Array.isArray(product.variations) && product.variations.length > 0) {
      skipped += 1;
      continue;
    }

    const batches = batchesByProduct.get(productSnapshot.id) || [];
    const hasBatchRecords = batches.length > 0;
    const sellableBatches = batches.filter(
      (batch) =>
        batch.archived !== true &&
        batch.status === "Available" &&
        Number.isFinite(Number(batch.stock)) &&
        Number(batch.stock) > 0
    );
    const stock = hasBatchRecords
      ? sellableBatches.reduce((total, batch) => total + Number(batch.stock), 0)
      : validAmount(product.stock) || 0;
    const price =
      validAmount(product.price) ??
      validAmount(sellableBatches[0] && sellableBatches[0].price);

    if (price === null) {
      skipped += 1;
      console.warn(
        "Skipped product with no valid price:",
        productSnapshot.id,
        product.name || ""
      );
      continue;
    }

    const unit =
      String(product.unit || (sellableBatches[0] && sellableBatches[0].unit) || "unit").trim() ||
      "unit";
    const variation = {
      id: "legacy-default",
      name: unit,
      price,
      stock,
      unit,
      status: stock > 0 ? "Available" : "Out of Stock",
    };
    const summary = {
      variations: [variation],
      price,
      stock,
      unit,
      status: stock > 0 ? "Available" : "Out of Stock",
      updatedAt: Date.now(),
    };

    console.log(
      `${apply ? "Migrate" : "Would migrate"} ${productSnapshot.id} (${product.name || "unnamed"}): ${stock} ${unit} at ₱${price}.`
    );
    if (apply) {
      await productSnapshot.ref.update(summary);
    }
    migrated += 1;
  }

  console.log(`Products scanned: ${productsSnapshot.size}`);
  console.log(`Products ${apply ? "migrated" : "ready to migrate"}: ${migrated}`);
  console.log(`Products skipped: ${skipped}`);
  console.log(`Legacy batch documents retained: ${batchesSnapshot.size}`);
  if (!apply) {
    console.log("Dry run only. Re-run with --apply after taking a Firestore backup.");
  }
}

main().catch((error) => {
  console.error("Product variation migration failed:", error);
  process.exitCode = 1;
});
