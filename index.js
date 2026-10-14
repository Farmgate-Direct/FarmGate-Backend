const express = require("express");
const cors = require("cors");
const cloudinary = require("cloudinary").v2;
const crypto = require("crypto");
require("dotenv").config();

const {
  createWalletRouter,
  handleCommissionDepositWebhook,
} = require("./walletRoutes");

const {
  initializeApp,
  getApps,
  getApp,
  cert,
} = require("firebase-admin/app");

const { getAuth } = require("firebase-admin/auth");

const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const {
  isSmtpConfigured,
  sendVerificationEmail,
  sendRejectionEmail,
  sendApprovalEmail,
} = require("./emailService");

const app = express();

app.use(cors());

app.use(
  express.json({
    limit: "2mb",
  })
);

/* =========================================================
   ENVIRONMENT HELPERS
========================================================= */

const getEnv = (name) => {
  const value = process.env[name];

  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  return value.trim();
};

// Safe: invalid values become 0.
const roundMoney = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round((number + Number.EPSILON) * 100) / 100;
};

const getCommissionRate = () => {
  const configured = Number(getEnv("FARMGATE_COMMISSION_RATE") || 0.03);

  return Number.isFinite(configured) && configured >= 0 ? configured : 0.03;
};

const {
  DeliveryFeeError,
  farmLocationFromProfile,
  buyerLocationFromAddress,
} = require("./deliveryFee");

const {
  resolveDeliveryForOrder,
  resolveDeliveryBatch,
} = require("./deliveryService");

const { checkQuoteRateLimit } = require("./quoteRateLimit");

const {
  normalizeEggVariant,
  resolveEggLine,
  roundStock6,
} = require("./eggVariants");

// No flat-fee fallback: new orders always use Haversine × road factor.
// Old orders that already have a fee keep the written fee (legacy keep).

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const httpError = (status, message) =>
  Object.assign(new Error(message), { status });

/* =========================================================
   FIREBASE ADMIN
========================================================= */

const firebaseProjectId = getEnv("FIREBASE_PROJECT_ID");
const firebaseClientEmail = getEnv("FIREBASE_CLIENT_EMAIL");

const firebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY
  ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n").trim()
  : undefined;

if (!firebaseProjectId || !firebaseClientEmail || !firebasePrivateKey) {
  throw new Error(
    "Firebase Admin credentials are incomplete. Check FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY."
  );
}

const firebaseApp =
  getApps().length > 0
    ? getApp()
    : initializeApp({
        credential: cert({
          projectId: firebaseProjectId,
          clientEmail: firebaseClientEmail,
          privateKey: firebasePrivateKey,
        }),
      });

const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

/* =========================================================
   CLOUDINARY
========================================================= */

const cloudinaryCloudName = getEnv("CLOUD_NAME");
const cloudinaryApiKey = getEnv("CLOUD_API_KEY");
const cloudinaryApiSecret = getEnv("CLOUD_API_SECRET");

if (!cloudinaryCloudName || !cloudinaryApiKey || !cloudinaryApiSecret) {
  console.warn("WARNING: Cloudinary environment variables are incomplete.");
}

cloudinary.config({
  cloud_name: cloudinaryCloudName,
  api_key: cloudinaryApiKey,
  api_secret: cloudinaryApiSecret,
});

/* =========================================================
   XENDIT
========================================================= */

const XENDIT_BASE_URL = "https://api.xendit.co";
const XENDIT_API_VERSION = "2024-11-11";
const XENDIT_TIMEOUT_MS = 20000;

/* =========================================================
   CUSTOM ERRORS
========================================================= */

class StockFulfillmentError extends Error {
  constructor(message) {
    super(message);
    this.name = "StockFulfillmentError";
    this.code = "STOCK_UNAVAILABLE";
  }
}

// Payment is valid but the order can no longer be fulfilled automatically.
class FulfillmentBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "FulfillmentBlockedError";
    this.code = "FULFILLMENT_BLOCKED";
  }
}

/* =========================================================
   XENDIT AUTH + REQUEST
========================================================= */

const getXenditAuthHeader = () => {
  const secretKey = getEnv("XENDIT_SECRET_KEY");

  if (!secretKey) {
    throw new Error("XENDIT_SECRET_KEY is not configured.");
  }

  return `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`;
};

const xenditRequest = async (path, options = {}) => {
  const response = await fetch(`${XENDIT_BASE_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(XENDIT_TIMEOUT_MS),
    headers: {
      Authorization: getXenditAuthHeader(),
      "Content-Type": "application/json",
      "api-version": XENDIT_API_VERSION,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      data?.message ||
        data?.error_code ||
        `Xendit request failed with status ${response.status}`
    );

    error.status = response.status;
    error.response = data;

    throw error;
  }

  return data;
};

/* =========================================================
   FIREBASE AUTH VERIFICATION
========================================================= */

const verifyFirebaseUser = async (req) => {
  const authorization = req.headers.authorization;

  if (!authorization || !authorization.startsWith("Bearer ")) {
    throw httpError(401, "Missing Firebase authentication token.");
  }

  try {
    return await auth.verifyIdToken(authorization.substring("Bearer ".length));
  } catch {
    throw httpError(401, "Invalid or expired login session.");
  }
};

/* =========================================================
   SAFE STRING COMPARISON
========================================================= */

const safeCompare = (first, second) => {
  if (typeof first !== "string" || typeof second !== "string") {
    return false;
  }

  const firstBuffer = Buffer.from(first, "utf8");
  const secondBuffer = Buffer.from(second, "utf8");

  if (firstBuffer.length !== secondBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(firstBuffer, secondBuffer);
};

/* =========================================================
   MISC HELPERS
========================================================= */

const getRedirectUrl = (actions) => {
  if (!Array.isArray(actions)) return null;

  const redirectAction = actions.find(
    (action) => action?.type === "REDIRECT_CUSTOMER"
  );

  return redirectAction?.value || redirectAction?.url || null;
};

const toMillis = (value) => {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value === "number") return value;

  if (typeof value === "string") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
};

const getFreshnessLabel = (batch) => {
  if (!batch?.weekEnd) {
    return batch?.freshness || "";
  }

  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  const daysAgo = Math.floor((Date.now() - toMillis(batch.weekEnd)) / MS_PER_DAY);

  return daysAgo <= 0 ? "Harvested this week" : `Harvested ${daysAgo}d ago`;
};

const getCurrentBatch = (snapshot) => {
  const batches = snapshot.docs
    .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
    .filter((batch) => batch.archived !== true)
    .sort(
      (first, second) =>
        Number(second.batchNumber || 0) - Number(first.batchNumber || 0)
    );

  return batches[0] || null;
};

const getCapturedAmount = (data) =>
  Number(
    data?.captures?.find((capture) => capture?.status === "SUCCEEDED")
      ?.capture_amount ??
      data?.captures?.[0]?.capture_amount ??
      data?.request_amount
  );

/* =========================================================
   FIND ORDER FROM XENDIT WEBHOOK
========================================================= */

const findOrderFromWebhook = async (data) => {
  const metadataOrderId =
    data?.metadata?.orderId || data?.metadata?.order_id || null;

  if (metadataOrderId) {
    const orderSnap = await db
      .collection("orders")
      .doc(String(metadataOrderId))
      .get();

    if (orderSnap.exists) return orderSnap;
  }

  if (data?.payment_request_id) {
    const querySnapshot = await db
      .collection("orders")
      .where("xenditPaymentRequestId", "==", data.payment_request_id)
      .limit(1)
      .get();

    if (!querySnapshot.empty) return querySnapshot.docs[0];
  }

  if (data?.reference_id) {
    const referenceSnapshot = await db
      .collection("orders")
      .where("xenditReferenceId", "==", data.reference_id)
      .limit(1)
      .get();

    if (!referenceSnapshot.empty) return referenceSnapshot.docs[0];

    const orderNumberSnapshot = await db
      .collection("orders")
      .where("orderNumber", "==", data.reference_id)
      .limit(1)
      .get();

    if (!orderNumberSnapshot.empty) return orderNumberSnapshot.docs[0];
  }

  return null;
};

/* =========================================================
   VALIDATE ORDER BEFORE PAYMENT
   - Re-prices everything from the products collection.
   - Locks subtotal / fee / total / commission on the server.
========================================================= */

const validateOrderForPayment = async (orderRef) => {
  // Delivery is priced synchronously inside the transaction below
  // (Haversine × road factor, pure local compute) — no pre-resolution needed.
  return await db.runTransaction(async (transaction) => {
    const orderSnap = await transaction.get(orderRef);

    if (!orderSnap.exists) {
      throw httpError(400, "Order not found.");
    }

    const order = orderSnap.data();

    if (order.payment !== "gcash") {
      throw httpError(400, "Only GCash orders can use Xendit.");
    }

    if (order.status === "cancelled") {
      throw httpError(400, "This order has already been cancelled.");
    }

    // The farmer must accept before the buyer can pay.
    if (order.status !== "accepted") {
      throw httpError(400, "The farmer must accept the order before GCash payment.");
    }

    if (order.paymentStatus === "paid") {
      throw httpError(400, "This order has already been paid.");
    }

    const orderProducts = Array.isArray(order.products) ? order.products : [];

    if (orderProducts.length === 0) {
      throw httpError(400, "Order contains no products.");
    }

    // Group lines by product. The same egg product may appear twice
    // (half tray + full tray) — duplicate means SAME product AND SAME
    // variant. Stock is checked against the COMBINED base quantity.
    const productGroups = new Map();
    const seenLineKeys = new Set();

    orderProducts.forEach((orderProduct, index) => {
      const productId = String(orderProduct.productId || "");

      if (!productId) {
        throw httpError(400, "Order contains an invalid productId.");
      }

      const variantKey = normalizeEggVariant(orderProduct.eggVariant) || "";
      const lineKey = `${productId}|${variantKey}`;

      if (seenLineKeys.has(lineKey)) {
        throw httpError(400, `Duplicate product in order: ${productId}`);
      }

      seenLineKeys.add(lineKey);

      const quantity = Number(orderProduct.quantity);

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw httpError(400, `Invalid quantity for ${productId}.`);
      }

      if (!productGroups.has(productId)) productGroups.set(productId, []);
      productGroups.get(productId).push({ orderProduct, index });
    });

    const validatedByIndex = new Array(orderProducts.length);

    let computedSubtotal = 0;

    for (const [productId, entries] of productGroups) {
      const productRef = db.collection("products").doc(productId);
      const productSnap = await transaction.get(productRef);

      if (!productSnap.exists) {
        throw httpError(400, `Product ${productId} not found.`);
      }

      const product = productSnap.data();

      if (product.farmerId !== order.farmerId) {
        throw httpError(400, `Product ${productId} does not belong to this farmer.`);
      }

      if (product.archived === true) {
        throw httpError(400, `Product ${product.name || productId} is archived.`);
      }

      // Resolve each line against the SERVER product. Egg-variant lines
      // are priced from the server base price (client price ignored);
      // normal lines keep the server price as before.
      const resolved = entries.map(({ orderProduct, index }) => {
        const egg = resolveEggLine(product, orderProduct);
        const quantity = Number(orderProduct.quantity);

        if (egg) {
          return {
            orderProduct,
            index,
            egg,
            price: egg.variantPrice,
            unit: egg.variantUnit,
            baseQty: egg.baseQty,
          };
        }

        const price = Number(product.price);

        if (!Number.isFinite(price) || price < 0) {
          throw httpError(400, `Invalid price for ${product.name || productId}.`);
        }

        return {
          orderProduct,
          index,
          egg: null,
          price,
          unit: product.unit || orderProduct.unit || "",
          baseQty: quantity,
        };
      });

      const batchSnapshot = await transaction.get(
        db.collection("productBatches").where("productId", "==", productId)
      );

      const currentBatch = getCurrentBatch(batchSnapshot);

      if (!currentBatch) {
        throw new StockFulfillmentError(
          `No current batch found for ${product.name || productId}.`
        );
      }

      const currentStock = Number(currentBatch.stock);

      if (
        currentBatch.status !== "Available" ||
        !Number.isFinite(currentStock) ||
        currentStock <= 0
      ) {
        throw new StockFulfillmentError(
          `${product.name || productId} is out of stock.`
        );
      }

      const totalBase = roundStock6(
        resolved.reduce((sum, r) => sum + Number(r.baseQty || 0), 0)
      );

      if (currentStock < totalBase) {
        throw new StockFulfillmentError(
          `Insufficient stock for ${product.name || productId}. Available: ${currentStock}, Requested: ${totalBase}.`
        );
      }

      for (const r of resolved) {
        const quantity = Number(r.orderProduct.quantity);

        computedSubtotal += roundMoney(r.price * quantity);

        validatedByIndex[r.index] = {
          productId,
          batchId: null,
          batchNumber: null,
          harvestRecordId: null,
          contributions: [],
          name: product.name || r.orderProduct.name || "",
          image: product.image || r.orderProduct.image || "",
          price: r.price,
          quantity,
          unit: r.unit,
          eggVariant: r.egg ? r.egg.variant : null,
          baseUnit: r.egg ? r.egg.baseUnit : product.unit || "",
          baseQuantity: r.egg ? r.egg.baseQty : quantity,
          reviewed: r.orderProduct.reviewed || false,
        };
      }
    }

    const validatedProducts = validatedByIndex;

    // ---- Delivery fee: preview-only quote, fixed at creation ----
    // The fee stored on the order (written by POST /orders) is used as-is
    // here — the server does NOT recompute at payment. Products below are
    // still re-priced from server data; the written fee/distance/total stay
    // fixed after payment.
    const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const deliveryFee = order.delivery === "delivery" ? roundMoney(Number(order.deliveryFee) || 0) : 0;
    const distanceKm = order.delivery === "delivery" ? numOrNull(order.distanceKm) ?? 0 : 0;
    const adjustedDistanceKm = order.delivery === "delivery" ? numOrNull(order.adjustedDistanceKm) : null;
    const deliveryTier = order.delivery === "delivery" ? (order.deliveryTier ?? null) : null;
    const feeStatus = "ok";
    const roadFactor = order.delivery === "delivery" ? numOrNull(order.roadFactor) : null;
    const tierVersion = order.delivery === "delivery" ? (order.tierVersion ?? null) : null;
    const deliveryMethod = order.delivery === "delivery" ? (order.deliveryMethod ?? null) : null;

    const finalSubtotal = roundMoney(computedSubtotal);
    const finalTotal = roundMoney(finalSubtotal + deliveryFee);

    if (finalTotal < 1) {
      throw httpError(400, "GCash payment must be at least ₱1.00.");
    }

    if (finalTotal > 100000) {
      throw httpError(400, "GCash payment cannot exceed ₱100,000.00.");
    }

    const commissionRate = getCommissionRate();
    const commissionAmount = roundMoney(finalSubtotal * commissionRate);
    const farmerEarning = roundMoney(
      Math.max(0, finalSubtotal - commissionAmount)
    );

    transaction.update(orderRef, {
      products: validatedProducts,
      subTotal: finalSubtotal,
      deliveryFee,
      distanceKm: distanceKm ?? null,
      adjustedDistanceKm: adjustedDistanceKm ?? null,
      deliveryTier: deliveryTier ?? null,
      feeStatus: feeStatus ?? "ok",
      roadFactor: roadFactor ?? null,
      tierVersion: tierVersion ?? null,
      deliveryMethod: deliveryMethod ?? null,
      total: finalTotal,

      commissionRate,
      commissionAmount,
      farmerEarning,

      payment: "gcash",
      paymentStatus: "pending",
      inventoryFulfilled: false,
      fulfillmentStatus: "pending",
      serverValidated: true,
      serverValidatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      orderId: orderSnap.id,
      orderNumber: order.orderNumber || null,
      buyerId: order.buyerId,
      farmerId: order.farmerId,
      farmName: order.farmName || null,
      total: finalTotal,
      subtotal: finalSubtotal,
      deliveryFee,
      distanceKm: distanceKm ?? null,
      adjustedDistanceKm: adjustedDistanceKm ?? null,
      deliveryTier: deliveryTier ?? null,
      feeStatus: feeStatus ?? "ok",
      roadFactor: roadFactor ?? null,
      tierVersion: tierVersion ?? null,
      deliveryMethod: deliveryMethod ?? null,
      products: validatedProducts,
    };
  });
};

/* =========================================================
   INVENTORY FULFILLMENT (shared by GCash payment and COD processing)

   planInventory       -> READS ONLY  (must run before any write)
   applyInventoryPlans -> WRITES ONLY
========================================================= */

// Splits fulfillment contributions across same-product order lines
// (ex. half tray + full tray of one egg product) proportionally to
// each line's base quantity, so per-line restock restores exactly
// what was deducted. Quantities stay in BASE units.
const splitContributions = (contributions, baseQuantities) => {
  const total = roundStock6(
    baseQuantities.reduce((sum, q) => sum + Number(q || 0), 0)
  );
  const result = baseQuantities.map(() => []);

  if (!(total > 0)) return result;

  contributions.forEach((c) => {
    let assigned = 0;

    baseQuantities.forEach((share, i) => {
      if (i === baseQuantities.length - 1) {
        const rest = roundStock6(Number(c.quantity) - assigned);
        if (rest > 0) result[i].push({ ...c, quantity: rest });
      } else {
        const part = roundStock6(
          (Number(c.quantity) * Number(share || 0)) / total
        );
        assigned = roundStock6(assigned + part);
        if (part > 0) result[i].push({ ...c, quantity: part });
      }
    });
  });

  return result;
};

const planInventory = async (transaction, order) => {
  const orderProducts = Array.isArray(order.products) ? order.products : [];

  if (orderProducts.length === 0) {
    throw new Error("Order contains no products.");
  }

  // Group lines by product. The same egg product may appear as half
  // tray + full tray lines — duplicate means SAME product AND SAME
  // variant. Stock is deducted ONCE per product using the combined
  // BASE quantity (variant qty converted to farmer-listing units).
  const productGroups = new Map();
  const seenLineKeys = new Set();

  orderProducts.forEach((orderProduct, index) => {
    const productId = String(orderProduct.productId || "");
    const quantity = Number(orderProduct.quantity);

    if (!productId) {
      throw new Error("Invalid product ID in order.");
    }

    const variantKey = normalizeEggVariant(orderProduct.eggVariant) || "";
    const lineKey = `${productId}|${variantKey}`;

    if (seenLineKeys.has(lineKey)) {
      throw new Error(`Duplicate product in order: ${productId}`);
    }

    seenLineKeys.add(lineKey);

    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Invalid quantity for ${productId}.`);
    }

    if (!productGroups.has(productId)) productGroups.set(productId, []);
    productGroups.get(productId).push({ orderProduct, index });
  });

  const plans = [];
  const updatedByIndex = new Array(orderProducts.length);

  for (const [productId, entries] of productGroups) {
    const productRef = db.collection("products").doc(productId);
    const productSnap = await transaction.get(productRef);

    if (!productSnap.exists) {
      throw new Error(`Product ${productId} not found.`);
    }

    const product = productSnap.data();

    if (product.farmerId !== order.farmerId) {
      throw new Error(`Product ${productId} does not belong to the order farmer.`);
    }

    // Resolve egg variants against the SERVER product. Client price
    // is display-only here; stock math always uses base quantities.
    const resolved = entries.map(({ orderProduct, index }) => {
      const egg = resolveEggLine(product, orderProduct);
      const quantity = Number(orderProduct.quantity);
      return {
        orderProduct,
        index,
        baseQty: egg ? egg.baseQty : quantity,
      };
    });

    const totalBase = roundStock6(
      resolved.reduce((sum, r) => sum + Number(r.baseQty || 0), 0)
    );

    if (!(totalBase > 0)) {
      throw new Error(`Invalid quantity for ${productId}.`);
    }

    const batchSnapshot = await transaction.get(
      db.collection("productBatches").where("productId", "==", productId)
    );

    const currentBatch = getCurrentBatch(batchSnapshot);

    if (!currentBatch) {
      throw new StockFulfillmentError(
        `No current batch found for ${product.name || productId}.`
      );
    }

    const currentStock = Number(currentBatch.stock);

    if (
      currentBatch.status !== "Available" ||
      !Number.isFinite(currentStock) ||
      currentStock <= 0
    ) {
      throw new StockFulfillmentError(
        `${product.name || productId} is out of stock.`
      );
    }

    if (currentStock < totalBase) {
      throw new StockFulfillmentError(
        `Insufficient stock for ${product.name || productId}. Available: ${currentStock}, Requested: ${totalBase}.`
      );
    }

    const harvestSnapshot = await transaction.get(
      db.collection("harvestRecords").where("batchId", "==", currentBatch.id)
    );

    // FIFO: oldest harvest first
    const harvestRecords = harvestSnapshot.docs
      .map((harvestDoc) => ({ id: harvestDoc.id, ...harvestDoc.data() }))
      .sort((first, second) => toMillis(first.harvestDate) - toMillis(second.harvestDate))
      .filter((record) => Number(record.remainingQuantity || 0) > 0);

    const contributions = [];
    const harvestUpdates = [];

    let remaining = totalBase;

    for (const record of harvestRecords) {
      if (remaining <= 0) break;

      const available = Number(record.remainingQuantity || 0);
      const take = Math.min(available, remaining);

      harvestUpdates.push({
        ref: db.collection("harvestRecords").doc(record.id),
        remainingQuantity: Number((available - take).toFixed(6)),
      });

      contributions.push({
        batchId: currentBatch.id,
        batchNumber: currentBatch.batchNumber,
        harvestRecordId: record.id,
        quantity: take,
      });

      remaining -= take;
    }

    // Legacy fallback: batch stock without harvest records
    if (remaining > 0) {
      contributions.push({
        batchId: currentBatch.id,
        batchNumber: currentBatch.batchNumber,
        harvestRecordId: null,
        quantity: remaining,
      });

      remaining = 0;
    }

    const newStock = Number((currentStock - totalBase).toFixed(6));
    const newStatus = newStock <= 0 ? "Out of Stock" : "Available";

    plans.push({
      productId,
      quantity: totalBase,
      batchRef: db.collection("productBatches").doc(currentBatch.id),
      newStock,
      newStatus,
      freshness: getFreshnessLabel(currentBatch),
      harvestUpdates,
    });

    // Split contributions across same-product lines so each line
    // carries only its own share (restock-safe).
    const split = splitContributions(
      contributions,
      resolved.map((r) => r.baseQty)
    );

    resolved.forEach((r, i) => {
      const lineContribs = split[i] && split[i].length > 0 ? split[i] : [];
      const primary = lineContribs[0] || contributions[0] || null;

      updatedByIndex[r.index] = {
        ...r.orderProduct,
        batchId: primary?.batchId ?? null,
        batchNumber: primary?.batchNumber ?? null,
        harvestRecordId: primary?.harvestRecordId ?? null,
        contributions: lineContribs,
      };
    });
  }

  return { plans, updatedProducts: updatedByIndex };
};

const applyInventoryPlans = (transaction, plans) => {
  for (const plan of plans) {
    for (const harvestUpdate of plan.harvestUpdates) {
      transaction.update(harvestUpdate.ref, {
        remainingQuantity: harvestUpdate.remainingQuantity,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    transaction.update(plan.batchRef, {
      stock: plan.newStock,
      status: plan.newStatus,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const sellable = plan.newStock > 0 && plan.newStatus === "Available";

    transaction.update(db.collection("products").doc(plan.productId), {
      totalSales: FieldValue.increment(plan.quantity),
      weeklySales: FieldValue.increment(plan.quantity),
      monthlySales: FieldValue.increment(plan.quantity),
      stock: plan.newStock,
      status: sellable ? "Available" : "Out of Stock",
      freshness: plan.freshness,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
};

/* =========================================================
   RESTOCK (undo planInventory when an accepted COD order is cancelled)

   planRestock  -> READS ONLY  (must run before any write)
   applyRestock -> WRITES ONLY
   Uses the batch / harvest "contributions" that were saved on each
   order product when the stock was deducted.
========================================================= */

const round6 = (value) => Number(Number(value).toFixed(6));

const planRestock = async (transaction, order) => {
  const items = Array.isArray(order.products) ? order.products : [];

  const writes = [];
  let skipped = false;

  for (const item of items) {
    const productId = String(item?.productId || "");

    const contributions = (
      Array.isArray(item?.contributions) ? item.contributions : []
    ).filter((c) => Number(c?.quantity) > 0);

    // No trace of where the stock came from -> cannot restore automatically.
    if (!productId || contributions.length === 0) {
      skipped = true;
      continue;
    }

    const byBatch = new Map();
    const byHarvest = new Map();
    let totalQuantity = 0;

    for (const contribution of contributions) {
      const quantity = Number(contribution.quantity);

      totalQuantity += quantity;

      if (contribution.batchId) {
        const key = String(contribution.batchId);
        byBatch.set(key, (byBatch.get(key) || 0) + quantity);
      }

      if (contribution.harvestRecordId) {
        const key = String(contribution.harvestRecordId);
        byHarvest.set(key, (byHarvest.get(key) || 0) + quantity);
      }
    }

    const productRef = db.collection("products").doc(productId);
    const harvestIds = Array.from(byHarvest.keys());

    // ---------- READS ----------
    const [productSnap, batchSnapshot, ...harvestSnaps] = await Promise.all([
      transaction.get(productRef),
      transaction.get(
        db.collection("productBatches").where("productId", "==", productId)
      ),
      ...harvestIds.map((id) =>
        transaction.get(db.collection("harvestRecords").doc(id))
      ),
    ]);

    // ---------- BATCHES ----------
    const batches = batchSnapshot.docs.map((docSnap) => {
      const data = docSnap.data() || {};
      const restoreQuantity = byBatch.get(docSnap.id) || 0;

      const stock = Number(data.stock || 0);
      const newStock = restoreQuantity > 0 ? round6(stock + restoreQuantity) : stock;

      const newStatus =
        restoreQuantity > 0 && data.status === "Out of Stock" && newStock > 0
          ? "Available"
          : data.status;

      return {
        id: docSnap.id,
        ref: docSnap.ref,
        data,
        restoreQuantity,
        stock: newStock,
        status: newStatus,
      };
    });

    for (const batch of batches) {
      if (batch.restoreQuantity > 0) {
        writes.push({
          ref: batch.ref,
          data: { stock: batch.stock, status: batch.status },
        });
      }
    }

    // ---------- HARVEST RECORDS ----------
    harvestSnaps.forEach((harvestSnap, index) => {
      if (!harvestSnap.exists) return;

      const remaining = Number(harvestSnap.data()?.remainingQuantity || 0);

      writes.push({
        ref: harvestSnap.ref,
        data: {
          remainingQuantity: round6(
            remaining + (byHarvest.get(harvestIds[index]) || 0)
          ),
        },
      });
    });

    // ---------- PRODUCT (mirrors what planInventory/applyInventoryPlans wrote) ----------
    if (productSnap.exists) {
      const product = productSnap.data() || {};

      const current = batches
        .filter((batch) => batch.data.archived !== true)
        .sort(
          (first, second) =>
            Number(second.data.batchNumber || 0) -
            Number(first.data.batchNumber || 0)
        )[0];

      const productUpdate = {
        totalSales: Math.max(0, Number(product.totalSales || 0) - totalQuantity),
        weeklySales: Math.max(0, Number(product.weeklySales || 0) - totalQuantity),
        monthlySales: Math.max(
          0,
          Number(product.monthlySales || 0) - totalQuantity
        ),
      };

      if (current) {
        const sellable = current.stock > 0 && current.status === "Available";

        productUpdate.stock = current.stock;
        productUpdate.status = sellable ? "Available" : "Out of Stock";
        productUpdate.freshness = getFreshnessLabel(current.data);
      }

      writes.push({ ref: productRef, data: productUpdate });
    }
  }

  return { writes, skipped };
};

const applyRestock = (transaction, plan) => {
  for (const write of plan.writes) {
    transaction.update(write.ref, {
      ...write.data,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
};

/* =========================================================
   FARMER WALLET / PAYOUT ROUTES
   (mounted here because it needs the inventory helpers above)
========================================================= */

app.use(
  "/wallet",
  createWalletRouter({
    db,
    auth,
    getEnv,
    inventory: {
      planInventory,
      applyInventoryPlans,
      planRestock,
      applyRestock,
    },
  })
);

/* =========================================================
   FULFILL PAID GCASH ORDER
   Money is NOT touched here. The farmer is credited only when the
   order is delivered (wallet route), and "pending" earnings are
   computed from orders on demand.
========================================================= */

const fulfillPaidOrder = async (orderRef, paymentData) => {
  return await db.runTransaction(async (transaction) => {
    const orderSnap = await transaction.get(orderRef);

    if (!orderSnap.exists) {
      throw new Error("Order not found.");
    }

    const order = orderSnap.data();

    // Idempotency
    if (order.inventoryFulfilled === true) {
      return { alreadyFulfilled: true };
    }

    if (order.payment !== "gcash") {
      throw new Error("Only GCash orders can be fulfilled here.");
    }

    // The order may have been cancelled between the webhook pre-check and now.
    if (order.status === "cancelled") {
      throw new FulfillmentBlockedError(
        "Payment received after the order was cancelled."
      );
    }

    const orderTotal = Number(order.total);
    const capturedAmount = getCapturedAmount(paymentData);

    if (!Number.isFinite(orderTotal) || !Number.isFinite(capturedAmount)) {
      throw new Error("Invalid payment amount.");
    }

    if (Math.abs(orderTotal - capturedAmount) > 0.01) {
      throw new Error(
        `Payment amount mismatch. Order: ₱${orderTotal}, Xendit: ₱${capturedAmount}.`
      );
    }

    if (
      order.xenditPaymentRequestId &&
      paymentData?.payment_request_id &&
      order.xenditPaymentRequestId !== paymentData.payment_request_id
    ) {
      throw new Error("Xendit payment request ID does not match the order.");
    }

    if (
      order.xenditReferenceId &&
      paymentData?.reference_id &&
      order.xenditReferenceId !== paymentData.reference_id
    ) {
      throw new Error("Xendit reference ID does not match the order.");
    }

    if (paymentData?.status !== "SUCCEEDED") {
      throw new Error("Payment was not successfully captured.");
    }

    // ---------- READS ----------
    const { plans, updatedProducts } = await planInventory(transaction, order);

    // ---------- WRITES ----------
    applyInventoryPlans(transaction, plans);

    transaction.update(orderRef, {
      paymentStatus: "paid",
      xenditPaymentId: paymentData.payment_id || null,
      xenditPaymentRequestId:
        paymentData.payment_request_id || order.xenditPaymentRequestId || null,
      xenditReferenceId:
        paymentData.reference_id ||
        order.xenditReferenceId ||
        order.orderNumber ||
        null,
      xenditPaymentChannel: paymentData.channel_code || "GCASH",
      xenditPaymentStatus: paymentData.status || "SUCCEEDED",
      paidAt: FieldValue.serverTimestamp(),

      inventoryFulfilled: true,
      fulfillmentStatus: "fulfilled",
      inventoryFulfilledAt: FieldValue.serverTimestamp(),
      fulfillmentError: null,
      products: updatedProducts,

      // Wallet is credited at delivery, not here.
      farmerWalletCredited: false,
      farmerWalletCreditedAt: null,

      xenditWebhookEvent: "payment.capture",
      xenditWebhookReceivedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { alreadyFulfilled: false };
  });
};

/* Records that money arrived but the order needs a human (refund / stock). */
const recordPaidNeedsReview = (orderRef, data, fulfillmentStatus, message) =>
  orderRef.update({
    paymentStatus: "paid",
    xenditPaymentId: data.payment_id || null,
    xenditPaymentRequestId: data.payment_request_id || null,
    xenditReferenceId: data.reference_id || null,
    xenditPaymentChannel: data.channel_code || "GCASH",
    xenditPaymentStatus: data.status || "SUCCEEDED",
    paidAt: FieldValue.serverTimestamp(),

    inventoryFulfilled: false,
    fulfillmentStatus,
    fulfillmentError: message,

    xenditWebhookEvent: "payment.capture",
    xenditWebhookReceivedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

/* =========================================================
   HOME / HEALTH
========================================================= */

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "FarmGate Backend running...",
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    backend: "farmgate-backend",
    cloudinary: !!getEnv("CLOUD_NAME"),
    xendit: !!getEnv("XENDIT_SECRET_KEY"),
    xenditWebhook: !!getEnv("XENDIT_WEBHOOK_TOKEN"),
    firebase: !!getEnv("FIREBASE_PROJECT_ID"),
  });
});

/* =========================================================
   DELIVERY QUOTE (authoritative, barangay-centroid, Bulacan only, no GPS)
   POST /delivery/quote { items: [{ farmerId, key? }],
     buyerCity, buyerBarangay, buyerProvince?, delivery? }
   or { farmerId, buyerCity, buyerBarangay } for a single farm.
   - Farm barangay is read from users/{farmerId} (never from the client).
   - Buyer barangay comes from the picked address (city + barangay text).
   - One call quotes ALL farms in the cart (sync local compute).
     Client fee/distance preview is never trusted.
   ========================================================= */

app.post("/delivery/quote", async (req, res) => {
  try {
    const decoded = await verifyFirebaseUser(req);
    const quota = checkQuoteRateLimit(decoded?.uid);
    if (!quota.allowed) {
      res.set("Retry-After", String(Math.ceil(quota.retryAfterMs / 1000)));
      return res.status(429).json({
        success: false,
        code: "RATE_LIMITED",
        error: "Too many delivery quotes. Please wait a moment and tap Try again.",
      });
    }

    const delivery = req.body?.delivery || "delivery";
    if (delivery !== "delivery") {
      return res.json({
        success: true,
        deliveryFee: 0,
        distanceKm: 0,
        tier: null,
        quotes: [],
      });
    }

    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    // Buyer barangay comes from the picked address (city + barangay text).
    const address = req.body?.address || null;
    const buyer = {
      province: req.body?.buyerProvince ?? address?.province ?? "",
      city: req.body?.buyerCity ?? address?.city ?? address?.municipality ?? "",
      barangay: req.body?.buyerBarangay ?? address?.barangay ?? "",
    };

    // ---- Batch path: one call for all farms in the cart ----
    if (items) {
      if (items.length === 0) {
        return res.json({ success: true, quotes: [] });
      }
      if (items.length > 20) {
        return res.status(400).json({ success: false, error: "Too many farms in one quote (max 20)." });
      }
      const pairs = [];
      for (let i = 0; i < items.length; i++) {
        const farmerId = String(items[i]?.farmerId || "").trim();
        if (!farmerId) {
          return res.status(400).json({ success: false, error: `items[${i}].farmerId is missing.` });
        }
        pairs.push({ key: items[i]?.key || farmerId, farmerId, farmerLocation: null });
      }
      const snaps = await Promise.all(
        pairs.map((p) => db.collection("users").doc(p.farmerId).get())
      );
      for (let i = 0; i < pairs.length; i++) {
        if (!snaps[i].exists) {
          pairs[i].missingFarm = true;
        } else {
          pairs[i].farmerLocation = farmLocationFromProfile(snaps[i].data() || {});
        }
      }
      const missing = pairs.filter((p) => p.missingFarm);
      const results = resolveDeliveryBatch({
        pairs: pairs.filter((p) => !p.missingFarm),
        buyerLocation: buyer,
      });      const byKey = new Map(results.map((r) => [r.key, r]));
      return res.json({
        success: true,
        quotes: pairs.map((p) =>
          p.missingFarm
            ? { key: p.key, farmerId: p.farmerId, success: false, code: "FARM_NOT_FOUND", error: "Farm not found." }
            : byKey.get(p.key)
        ),
      });
    }

    // ---- Single-farm path ({ farmerId, buyerCity, buyerBarangay }) ----
    const farmerId = String(req.body?.farmerId || "").trim();
    if (!farmerId) {
      return res.status(400).json({ success: false, error: "Missing farmerId." });
    }
    const singleBuyer = {
      province: req.body?.buyerProvince ?? address?.province ?? "",
      city: req.body?.buyerCity ?? address?.city ?? address?.municipality ?? "",
      barangay: req.body?.buyerBarangay ?? address?.barangay ?? "",
    };

    const farmerSnap = await db.collection("users").doc(farmerId).get();
    if (!farmerSnap.exists) {
      return res.status(404).json({ success: false, error: "Farm not found." });
    }
    try {
      const r = resolveDeliveryForOrder({
        farmerProfile: farmerSnap.data() || {},
        order: { delivery: "delivery", address: singleBuyer },
      });
      return res.json({
        success: true,
        distanceKm: r.distanceKm,
        adjustedDistanceKm: r.adjustedDistanceKm,
        deliveryFee: r.deliveryFee,
        tier: r.tier,
        feeStatus: r.feeStatus,
        status: r.feeStatus,
        roadFactor: r.roadFactor,
        tierVersion: r.tierVersion,
        method: r.method || null,
      });
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: e.message,
        ...(e?.code ? { code: e.code } : {}),
      });
    }
  } catch (error) {
    console.error("DELIVERY QUOTE ERROR:", error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || "Unable to quote delivery.",
    });
  }
});

/* =========================================================
   CREATE ORDER (server-side — fee recomputed, client fee ignored)
   POST /orders {
     farmerId, farmName?, buyerName?, products: [{ productId, quantity,
       unit?, name?, image?, eggVariant?, baseQuantity? }],
     address | null, delivery: "delivery" | "pickup", payment: "gcash" | "cod",
     pickupDate?, pickupTime?, subTotal? (informational only)
   }
   - The buyer is the verified Firebase user (buyerId forced, never trusted).
   - The delivery fee is computed HERE from the farmer's stored barangay and
     the address barangay. Any deliveryFee/distance sent by the client is ignored.
   - Stock/prices are still validated at accept/payment (existing lifecycle).
   ========================================================= */

const generateOrderNumber = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const random = Math.floor(1000 + Math.random() * 9000);
  return `FG-${datePart}-${timePart}-${random}`;
};

app.post("/orders", async (req, res) => {
  try {
    const decoded = await verifyFirebaseUser(req);
    const body = req.body || {};

    const farmerId = String(body.farmerId || "").trim();
    if (!farmerId) {
      return res.status(400).json({ success: false, error: "Missing farmerId." });
    }

    const products = Array.isArray(body.products) ? body.products : [];
    if (products.length === 0) {
      return res.status(400).json({ success: false, error: "Order contains no products." });
    }
    for (const item of products) {
      if (!String(item?.productId || "").trim()) {
        return res.status(400).json({ success: false, error: "Order contains an invalid productId." });
      }
      const qty = Number(item?.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ success: false, error: `Invalid quantity for ${item?.productId}.` });
      }
    }

    const delivery = body.delivery === "pickup" ? "pickup" : "delivery";
    const payment = body.payment === "cod" ? "cod" : "gcash";
    if (body.payment && body.payment !== "cod" && body.payment !== "gcash") {
      return res.status(400).json({ success: false, error: "Order has an invalid payment method." });
    }

    const farmerSnap = await db.collection("users").doc(farmerId).get();
    if (!farmerSnap.exists) {
      return res.status(404).json({ success: false, error: "Farm not found." });
    }
    const farmerProfile = farmerSnap.data() || {};

    // Server-side fee (client fee/distance ignored). Throws for invalid
    // pins — order is not created.
    let quote = null;
    if (delivery === "delivery") {
      try {
        quote = resolveDeliveryForOrder({
          farmerProfile,
          order: { delivery: "delivery", address: body.address || null },
        });
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: e.message,
          ...(e?.code ? { code: e.code } : {}),
        });
      }
    }

    const subTotal = roundMoney(Number(body.subTotal) || 0);
    const deliveryFee = delivery === "delivery" ? quote.deliveryFee : 0;
    const orderNumber = generateOrderNumber();
    const commissionRate = getCommissionRate();
    const commissionAmount = roundMoney(subTotal * commissionRate);

    const record = {
      buyerId: decoded.uid,
      buyerName: String(body.buyerName || ""),
      farmerId,
      farmName: String(body.farmName || farmerProfile.farmName || ""),
      products,
      delivery,
      payment,
      address: body.address || null,
      pickupDate: body.pickupDate || null,
      pickupTime: body.pickupTime || null,
      subTotal,
      // Fee fields are SERVER-written. Clients cannot write them (rules).
      deliveryFee,
      distanceKm: delivery === "delivery" ? quote.distanceKm : 0,
      adjustedDistanceKm: delivery === "delivery" ? quote.adjustedDistanceKm : 0,
      deliveryTier: delivery === "delivery" ? quote.tier : null,
      feeStatus: delivery === "delivery" ? quote.feeStatus : "ok",
      roadFactor: delivery === "delivery" ? quote.roadFactor : null,
      tierVersion: delivery === "delivery" ? quote.tierVersion : null,
      deliveryMethod: delivery === "delivery" ? quote.method : null,
      total: roundMoney(subTotal + (deliveryFee || 0)),
      status: "pending",
      paymentStatus: "pending",
      inventoryFulfilled: false,
      fulfillmentStatus: "pending",
      commissionRate,
      commissionAmount,
      commissionStatus: "pending",
      farmerEarning: roundMoney(Math.max(0, subTotal - commissionAmount)),
      farmerWalletCredited: false,
      financialStatus: "pending",
      orderNumber,
      serverValidated: false,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection("orders").add(record);
    return res.json({
      success: true,
      orderId: docRef.id,
      orderNumber,
      deliveryFee,
      distanceKm: record.distanceKm,
      adjustedDistanceKm: record.adjustedDistanceKm,
      deliveryTier: record.deliveryTier,
      feeStatus: record.feeStatus,
      status: record.feeStatus,
      total: record.total,
    });
  } catch (error) {
    console.error("CREATE ORDER ERROR:", error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || "Unable to create this order.",
    });
  }
});

/* =========================================================
   DELETE CLOUDINARY IMAGE (authenticated)
========================================================= */

app.post("/delete-image", async (req, res) => {
  try {
    await verifyFirebaseUser(req);

    const { public_id } = req.body || {};

    if (!public_id || typeof public_id !== "string") {
      return res.status(400).json({
        success: false,
        error: "Missing public_id.",
      });
    }

    const result = await cloudinary.uploader.destroy(public_id);

    return res.json({ success: true, result });
  } catch (error) {
    console.error("DELETE IMAGE ERROR:", error);

    return res.status(error.status || 500).json({
      success: false,
      error: error.message,
    });
  }
});

/* =========================================================
   AUTH: SEND BRANDED VERIFICATION EMAIL (authenticated)
   - Gumagawa ng Firebase verification link (Admin SDK) at
     sine-send gamit ang FarmGate design via Gmail SMTP.
   - Kapag walang SMTP config, { sent: false } — ang mobile
     app ang magfa-fallback sa default Firebase email.
========================================================= */

app.post("/auth/send-verification", async (req, res) => {
  try {
    const decoded = await verifyFirebaseUser(req);

    const target = await auth.getUser(decoded.uid);

    if (!target.email) {
      return res.status(400).json({
        success: false,
        error: "Account has no email address.",
      });
    }

    if (target.emailVerified) {
      return res.json({ success: true, sent: true, alreadyVerified: true });
    }

    if (!isSmtpConfigured()) {
      return res.json({ success: true, sent: false, reason: "smtp-missing" });
    }

    const link = await auth.generateEmailVerificationLink(target.email);

    const userSnap = await db.collection("users").doc(decoded.uid).get();
    // Pangalan: unahin ang galing sa registration form (body), sunod ang
    // Firestore doc, huli ang Auth displayName.
    const fullName =
      String(req.body?.fullName || "").trim() ||
      (userSnap.exists ? String((userSnap.data() || {}).fullName || "") : "") ||
      String(target.displayName || "");

    const sent = await sendVerificationEmail(target.email, fullName, link);

    return res.json({ success: true, sent });
  } catch (error) {
    console.error("SEND VERIFICATION ERROR:", error);

    return res.status(error.status || 500).json({
      success: false,
      error: error.message || "Unable to send verification email.",
    });
  }
});

/* =========================================================
   AUTH: CHECK EMAIL STATUS (public, no auth required)
   - Email-based duplicate check para hindi na kailangan ng password
     para malaman kung pending / approved / banned ang email.
   - Returns { exists, status, emailVerified }.
   - status: "pending" | "approved" | "banned" | "rejected"
     | "no-doc" (Auth exists, walang Firestore doc)
     | "no-auth" (walang Auth account).
   - Rejected docs are auto-deleted, so "rejected" rarely occurs;
     frontend treats it as non-blocking (allow fresh).
   - Safe vs enumeration: Firebase Auth `email-already-in-use`
     already reveals existence on register, so this adds no new
     signal beyond status already shown in-app.
========================================================= */
app.post("/auth/check-email-status", async (req, res) => {
  try {
    const rawEmail = String(req.body?.email || "").trim();
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ||
      rawEmail.length > 254
    ) {
      return res.status(400).json({ success: false, error: "Invalid email." });
    }
    const emailLower = rawEmail.toLowerCase();

    let authUser = null;
    try {
      authUser = await auth.getUserByEmail(emailLower);
    } catch (e) {
      if (e?.code !== "auth/user-not-found") throw e;
      authUser = null;
    }

    // Auth exists — basahin ang Firestore doc by uid (source of truth).
    if (authUser) {
      const snap = await db.collection("users").doc(authUser.uid).get();
      if (snap.exists) {
        const data = snap.data() || {};
        const status = String(data.status ?? "pending").trim().toLowerCase() || "pending";
        return res.json({
          success: true,
          exists: true,
          status,
          emailVerified: !!authUser.emailVerified,
        });
      }
      // Auth exists pero walang doc — posibleng rejected (deleted)
      // o hindi pa tapos ang registration.
      // Fallback: hanapin din by email field (ibang uid, case variants).
      const byEmail =
        (await db.collection("users").where("email", "==", rawEmail).limit(1).get().catch(() => null)) ||
        null;
      let fallback = byEmail && !byEmail.empty ? byEmail.docs[0].data() || {} : null;
      if (!fallback && emailLower !== rawEmail) {
        const lowerSnap = await db
          .collection("users")
          .where("email", "==", emailLower)
          .limit(1)
          .get()
          .catch(() => null);
        if (lowerSnap && !lowerSnap.empty) fallback = lowerSnap.docs[0].data() || {};
      }
      if (fallback) {
        const status = String(fallback.status ?? "pending").trim().toLowerCase() || "pending";
        return res.json({
          success: true,
          exists: true,
          status,
          emailVerified: !!authUser.emailVerified,
        });
      }
      return res.json({
        success: true,
        exists: true,
        status: "no-doc",
        emailVerified: !!authUser.emailVerified,
      });
    }

    // Walang Auth — baka may Firestore doc pa rin (edge). Check by email.
    const snap = await db.collection("users").where("email", "==", rawEmail).limit(1).get().catch(() => null);
    let found = snap && !snap.empty ? snap.docs[0].data() || {} : null;
    if (!found && emailLower !== rawEmail) {
      const lowerSnap = await db
        .collection("users")
        .where("email", "==", emailLower)
        .limit(1)
        .get()
        .catch(() => null);
      if (lowerSnap && !lowerSnap.empty) found = lowerSnap.docs[0].data() || {};
    }
    if (found) {
      const status = String(found.status ?? "pending").trim().toLowerCase() || "pending";
      return res.json({ success: true, exists: true, status, emailVerified: false });
    }

    return res.json({ success: true, exists: false, status: "no-auth", emailVerified: false });
  } catch (error) {
    console.error("CHECK EMAIL STATUS ERROR:", error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || "Unable to check email status.",
    });
  }
});

/* =========================================================
   AUTH: RESEND VERIFICATION BY EMAIL (public, no auth required)
   - Para sa natigil na registration (nawala ang session pag
     nag-close ng app): makahingi ulit ng verification link
     gamit lang ang email, walang password, walang session.
   - 60s rate limit kada email para hindi ma-spam.
   - Kung verified na, { alreadyVerified: true } — ituloy na
     sa sign-in/finish, huwag nang mag-send.
========================================================= */
const resendVerificationLimits = new Map();

app.post("/auth/resend-verification", async (req, res) => {
  try {
    const rawEmail = String(req.body?.email || "").trim();
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ||
      rawEmail.length > 254
    ) {
      return res.status(400).json({ success: false, error: "Invalid email." });
    }
    const emailLower = rawEmail.toLowerCase();

    const now = Date.now();
    const lastSent = resendVerificationLimits.get(emailLower) || 0;
    if (now - lastSent < 60000) {
      return res.status(429).json({
        success: false,
        error: "Please wait a minute before requesting a new link.",
        retryAfterSecs: Math.ceil((60000 - (now - lastSent)) / 1000),
      });
    }

    let target;
    try {
      target = await auth.getUserByEmail(emailLower);
    } catch (e) {
      if (e?.code === "auth/user-not-found") {
        return res.json({ success: true, sent: false, exists: false });
      }
      throw e;
    }

    if (target.emailVerified) {
      return res.json({ success: true, sent: false, alreadyVerified: true });
    }

    if (!isSmtpConfigured()) {
      return res.json({ success: true, sent: false, reason: "smtp-missing" });
    }

    const link = await auth.generateEmailVerificationLink(target.email);

    let fullName = String(target.displayName || "");
    try {
      const userSnap = await db.collection("users").doc(target.uid).get();
      if (userSnap.exists) fullName = String((userSnap.data() || {}).fullName || fullName);
    } catch {
      // Best-effort lang ang pangalan — hindi hadlang sa send.
    }

    await sendVerificationEmail(target.email, fullName, link);
    resendVerificationLimits.set(emailLower, Date.now());

    return res.json({ success: true, sent: true });
  } catch (error) {
    console.error("RESEND VERIFICATION ERROR:", error);
    return res.status(error.status || 500).json({
      success: false,
      error: error.message || "Unable to resend verification email.",
    });
  }
});

/* =========================================================
   ADMIN: REJECT REGISTRATION (authenticated, admin-only)
   - Nagse-send muna ng branded rejection email (best-effort).
   - Deletes the Firestore doc (users/{uid}) so the request
     disappears from the approvals list.
   - Deletes the Firebase Auth account so the email can be
     used to register again.
   Pending users never transact, so no orders/products cleanup
   is needed here.
========================================================= */

app.delete("/admin/users/:uid", async (req, res) => {
  try {
    const decoded = await verifyFirebaseUser(req);

    const adminSnap = await db.collection("admins").doc(decoded.uid).get();
    let isAdmin =
      adminSnap.exists && (adminSnap.data() || {}).status === "Active";

    if (!isAdmin) {
      const userSnap = await db.collection("users").doc(decoded.uid).get();
      isAdmin =
        userSnap.exists && (userSnap.data() || {}).role === "admin";
    }

    if (!isAdmin) {
      throw httpError(403, "Only admin accounts can reject registrations.");
    }

    const uid = String(req.params.uid || "").trim();

    if (!uid || uid.length > 128) {
      return res.status(400).json({
        success: false,
        error: "Invalid user id.",
      });
    }

    // Kunin muna ang email/pangalan (kailangan sa rejection email),
    // saka burahin. Email ay background best-effort — hindi na hinihintay
    // para mabilis mag-toast ang admin at mawala agad sa listahan nang
    // walang refresh. Same response shape, walang UI na binabago.
    const targetSnap = await db.collection("users").doc(uid).get();
    const targetData = targetSnap.exists ? targetSnap.data() || {} : {};
    const targetEmail = targetData.email ? String(targetData.email) : "";
    const targetName = String(targetData.fullName || "");

    await db.collection("users").doc(uid).delete();

    try {
      await auth.deleteUser(uid);
    } catch (authError) {
      // Kapag wala nang Auth account (nabura na ng auto-screen),
      // success pa rin — ang mahalaga ay malinis ang Firestore.
      if (authError?.code !== "auth/user-not-found") {
        throw authError;
      }
    }

    // Background lang ang email — huwag nang i-await para hindi
    // mag-"Please wait..." nang matagal ang admin.
    if (targetEmail) {
      sendRejectionEmail(targetEmail, targetName, []).catch(() => {});
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("REJECT USER ERROR:", error);

    return res.status(error.status || 500).json({
      success: false,
      error: error.message || "Unable to reject this registration.",
    });
  }
});

/* =========================================================
   ADMIN: APPROVE REGISTRATION (authenticated, admin-only)
   - Sine-set ang Firestore doc (users/{uid}) to approved +
     approvedAt, tapos nagse-send ng branded approval email
     (best-effort, hindi humahadlang sa approval kahit mag-fail).
========================================================= */

app.post("/admin/users/:uid/approve", async (req, res) => {
  try {
    const decoded = await verifyFirebaseUser(req);

    const adminSnap = await db.collection("admins").doc(decoded.uid).get();
    let isAdmin =
      adminSnap.exists && (adminSnap.data() || {}).status === "Active";

    if (!isAdmin) {
      const userSnap = await db.collection("users").doc(decoded.uid).get();
      isAdmin =
        userSnap.exists && (userSnap.data() || {}).role === "admin";
    }

    if (!isAdmin) {
      throw httpError(403, "Only admin accounts can approve registrations.");
    }

    const uid = String(req.params.uid || "").trim();

    if (!uid || uid.length > 128) {
      return res.status(400).json({
        success: false,
        error: "Invalid user id.",
      });
    }

    const targetSnap = await db.collection("users").doc(uid).get();
    if (!targetSnap.exists) {
      return res.status(404).json({
        success: false,
        error: "User not found.",
      });
    }
    const targetData = targetSnap.data() || {};

    await db.collection("users").doc(uid).update({
      status: "approved",
      approvedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Background lang ang approval email — huwag nang i-await para hindi
    // mag-"Please wait..." nang matagal ang admin. Approved na agad,
    // mag-toast + mawawala sa listahan nang walang refresh.
    if (targetData.email) {
      sendApprovalEmail(
        String(targetData.email),
        String(targetData.fullName || "")
      ).catch(() => {});
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("APPROVE USER ERROR:", error);

    return res.status(error.status || 500).json({
      success: false,
      error: error.message || "Unable to approve this registration.",
    });
  }
});

/* =========================================================
   ORDER STATUS: PROCESSING
   - GCash: payment + inventory must already be fulfilled.
   - COD  : stock is normally already deducted when the farmer accepted
            the order. Only legacy accepted orders (inventoryFulfilled=false)
            are deducted here, atomically, on the server.
========================================================= */

app.post("/orders/:orderId/process", async (req, res) => {
  try {
    const decoded = await verifyFirebaseUser(req);

    const orderRef = db.collection("orders").doc(String(req.params.orderId));

    await db.runTransaction(async (transaction) => {
      const orderSnap = await transaction.get(orderRef);

      if (!orderSnap.exists) throw httpError(404, "Order not found.");

      const order = orderSnap.data();

      if (order.farmerId !== decoded.uid) {
        throw httpError(403, "You are not authorized to update this order.");
      }

      if (order.status !== "accepted") {
        throw httpError(400, "Only accepted orders can be processed.");
      }

      const processingFields = {
        status: "processing",
        processingAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (order.payment === "gcash") {
        if (order.paymentStatus !== "paid") {
          throw httpError(400, "This GCash order has not been paid yet.");
        }

        if (order.inventoryFulfilled !== true) {
          throw httpError(
            400,
            "This GCash order has not been fulfilled from inventory yet."
          );
        }

        transaction.update(orderRef, processingFields);
        return;
      }

      if (order.payment === "cod") {
        if (
          order.codCommissionReservationStatus !== "reserved" ||
          !(Number(order.codCommissionReserved) > 0)
        ) {
          throw httpError(
            400,
            "The COD commission reserve is missing for this order."
          );
        }

        if (order.inventoryFulfilled === true) {
          transaction.update(orderRef, processingFields);
          return;
        }

        // READS first, WRITES after
        const { plans, updatedProducts } = await planInventory(transaction, order);

        applyInventoryPlans(transaction, plans);

        transaction.update(orderRef, {
          ...processingFields,
          products: updatedProducts,
          inventoryFulfilled: true,
          fulfillmentStatus: "fulfilled",
          inventoryFulfilledAt: FieldValue.serverTimestamp(),
        });

        return;
      }

      throw httpError(400, "Order has an invalid payment method.");
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("PROCESS ORDER ERROR:", error);

    const statusCode =
      error.code === "STOCK_UNAVAILABLE" ? 409 : error.status || 400;

    return res.status(statusCode).json({
      success: false,
      error: error.message || "Unable to start processing this order.",
    });
  }
});

/* =========================================================
   ORDER STATUS: TO RECEIVE
========================================================= */

app.post("/orders/:orderId/to-receive", async (req, res) => {
  try {
    const decoded = await verifyFirebaseUser(req);

    const orderRef = db.collection("orders").doc(String(req.params.orderId));

    await db.runTransaction(async (transaction) => {
      const orderSnap = await transaction.get(orderRef);

      if (!orderSnap.exists) throw httpError(404, "Order not found.");

      const order = orderSnap.data();

      if (order.farmerId !== decoded.uid) {
        throw httpError(403, "You are not authorized to update this order.");
      }

      if (order.status !== "processing") {
        throw httpError(
          400,
          "Only processing orders can be marked as To Receive."
        );
      }

      transaction.update(orderRef, {
        status: "to_receive",
        toReceiveAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("TO RECEIVE ERROR:", error);

    return res.status(error.status || 400).json({
      success: false,
      error: error.message || "Unable to update this order.",
    });
  }
});

/* =========================================================
   CREATE XENDIT PAYMENT
========================================================= */

app.post("/create-payment", async (req, res) => {
  try {
    const { orderId } = req.body || {};

    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: "Missing orderId.",
      });
    }

    const decodedUser = await verifyFirebaseUser(req);

    const orderRef = db.collection("orders").doc(String(orderId));
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({
        success: false,
        error: "Order not found.",
      });
    }

    const order = orderSnap.data();

    if (order.buyerId !== decodedUser.uid) {
      return res.status(403).json({
        success: false,
        error: "You are not authorized to pay for this order.",
      });
    }

    if (order.payment !== "gcash") {
      return res.status(400).json({
        success: false,
        error: "This order is not a GCash order.",
      });
    }

    if (order.status === "cancelled") {
      return res.status(400).json({
        success: false,
        error: "This order has already been cancelled.",
      });
    }

    if (order.paymentStatus === "paid") {
      return res.json({
        success: true,
        alreadyPaid: true,
        orderId,
        paymentStatus: "paid",
      });
    }

    // Re-prices the order and enforces status === "accepted".
    const validated = await validateOrderForPayment(orderRef);

    const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || "")
      .trim()
      .replace(/\/+$/, "");

    if (!publicBaseUrl) {
      return res.status(500).json({
        success: false,
        error: "PUBLIC_BASE_URL is not configured.",
      });
    }

    // Reuse a still-open payment request (prevents double payments).
    const latestOrderSnap = await orderRef.get();
    const latestOrder = latestOrderSnap.data() || {};

    if (latestOrder.xenditPaymentRequestId) {
      try {
        const existingPayment = await xenditRequest(
          `/v3/payment_requests/${encodeURIComponent(
            latestOrder.xenditPaymentRequestId
          )}`,
          { method: "GET" }
        );

        const redirectUrl = getRedirectUrl(existingPayment.actions);

        const requestedAmount = Number(existingPayment.request_amount);

        const amountStillMatches =
          !Number.isFinite(requestedAmount) ||
          Math.abs(requestedAmount - validated.total) <= 0.01;

        if (
          redirectUrl &&
          amountStillMatches &&
          ["PENDING", "REQUIRES_ACTION"].includes(existingPayment.status)
        ) {
          return res.json({
            success: true,
            existingPayment: true,
            orderId,
            orderNumber: validated.orderNumber || null,
            paymentRequestId:
              existingPayment.payment_request_id || existingPayment.id || null,
            referenceId: existingPayment.reference_id || null,
            paymentStatus: existingPayment.status,
            amount: validated.total,
            redirectUrl,
          });
        }
      } catch (error) {
        console.log("EXISTING PAYMENT LOOKUP ERROR:", error.message);
      }
    }

    const referenceId = `${validated.orderNumber || orderId}-${Date.now()}`;

    const successReturnUrl = `${publicBaseUrl}/payment/success?orderId=${encodeURIComponent(orderId)}`;
    const failureReturnUrl = `${publicBaseUrl}/payment/failure?orderId=${encodeURIComponent(orderId)}`;

    const payload = {
      reference_id: referenceId,
      type: "PAY",
      country: "PH",
      currency: "PHP",
      request_amount: Number(validated.total.toFixed(2)),
      capture_method: "AUTOMATIC",
      channel_code: "GCASH",
      channel_properties: {
        success_return_url: successReturnUrl,
        failure_return_url: failureReturnUrl,
      },
      description: `FarmGate Order ${validated.orderNumber || orderId}`,
      metadata: {
        orderId: String(orderId),
        orderNumber: String(validated.orderNumber || ""),
        buyerId: String(validated.buyerId),
      },
    };

    console.log("CREATING XENDIT PAYMENT:", {
      orderId,
      referenceId,
      amount: validated.total,
    });

    const paymentRequest = await xenditRequest("/v3/payment_requests", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const redirectUrl = getRedirectUrl(paymentRequest.actions);

    if (!redirectUrl) {
      console.error("XENDIT DID NOT RETURN REDIRECT:", paymentRequest);

      return res.status(502).json({
        success: false,
        error: "Xendit did not return a customer redirect URL.",
      });
    }

    await orderRef.update({
      paymentStatus: "pending",
      xenditPaymentRequestId:
        paymentRequest.payment_request_id || paymentRequest.id || null,
      xenditReferenceId: paymentRequest.reference_id || referenceId,
      xenditPaymentChannel: paymentRequest.channel_code || "GCASH",
      xenditPaymentStatus: paymentRequest.status || "PENDING",
      inventoryFulfilled: false,
      fulfillmentStatus: "pending",
      paymentRequestCreatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return res.json({
      success: true,
      orderId,
      orderNumber: validated.orderNumber || null,
      paymentRequestId:
        paymentRequest.payment_request_id || paymentRequest.id || null,
      referenceId: paymentRequest.reference_id || referenceId,
      paymentStatus: paymentRequest.status || "PENDING",
      paymentChannel: paymentRequest.channel_code || "GCASH",
      amount: validated.total,
      redirectUrl,
    });
  } catch (error) {
    console.error("CREATE PAYMENT ERROR:", error);

    const statusCode =
      error.code === "STOCK_UNAVAILABLE" ? 409 : error.status || 500;

    return res.status(statusCode).json({
      success: false,
      error: error.message || "Unable to create Xendit payment.",
      details: error.response || null,
    });
  }
});

/* =========================================================
   GET PAYMENT STATUS (read-only, never calls Xendit)
========================================================= */

app.get("/payment-status/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    const decodedUser = await verifyFirebaseUser(req);

    const orderSnap = await db.collection("orders").doc(String(orderId)).get();

    if (!orderSnap.exists) {
      return res.status(404).json({
        success: false,
        error: "Order not found.",
      });
    }

    const order = orderSnap.data();

    if (order.buyerId !== decodedUser.uid) {
      return res.status(403).json({
        success: false,
        error: "You are not authorized to view this order.",
      });
    }

    return res.json({
      success: true,
      orderId,
      payment: order.payment || null,
      paymentStatus: order.paymentStatus || "pending",
      inventoryFulfilled: order.inventoryFulfilled === true,
      fulfillmentStatus: order.fulfillmentStatus || "pending",
      xenditPaymentRequestId: order.xenditPaymentRequestId || null,
      xenditPaymentId: order.xenditPaymentId || null,
      xenditReferenceId: order.xenditReferenceId || null,
      xenditPaymentChannel: order.xenditPaymentChannel || null,
      xenditPaymentStatus: order.xenditPaymentStatus || null,
      paymentFailureCode: order.paymentFailureCode || null,
      paymentFailureReason: order.paymentFailureReason || null,
      paymentRequestCreatedAt: order.paymentRequestCreatedAt || null,
      paidAt: order.paidAt || null,
      serverValidated: order.serverValidated === true,
      serverValidatedAt: order.serverValidatedAt || null,
      xenditWebhookEvent: order.xenditWebhookEvent || null,
      xenditWebhookReceivedAt: order.xenditWebhookReceivedAt || null,
      fulfillmentError: order.fulfillmentError || null,
      updatedAt: order.updatedAt || null,
    });
  } catch (error) {
    console.error("PAYMENT STATUS ERROR:", error);

    return res.status(error.status || 500).json({
      success: false,
      error: error.message || "Unable to get payment status.",
    });
  }
});

/* =========================================================
   PAYMENT SYNC (self-healing when the payment.capture webhook
   never arrives, e.g. wrong webhook URL in the dashboard).
   Asks Xendit for the live payment-request status and fulfills
   the order with the SAME guards as the webhook path.
   Never fulfills unless Xendit says SUCCEEDED and the amount
   and request IDs match the order.
========================================================= */

app.post("/payment-sync/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    const decodedUser = await verifyFirebaseUser(req);

    const orderRef = db.collection("orders").doc(String(orderId));
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      return res.status(404).json({
        success: false,
        error: "Order not found.",
      });
    }

    const order = orderSnap.data();

    if (order.buyerId !== decodedUser.uid) {
      return res.status(403).json({
        success: false,
        error: "You are not authorized to sync this order.",
      });
    }

    if (order.paymentStatus === "paid" || order.inventoryFulfilled === true) {
      return res.json({
        success: true,
        alreadyPaid: true,
        orderId: orderSnap.id,
        paymentStatus: order.paymentStatus || "paid",
      });
    }

    const paymentRequestId = order.xenditPaymentRequestId || null;

    if (!paymentRequestId) {
      return res.status(400).json({
        success: false,
        error: "This order has no GCash payment request to sync.",
      });
    }

    const pr = await xenditRequest(
      `/v3/payment_requests/${encodeURIComponent(paymentRequestId)}`,
      { method: "GET" }
    );

    const prStatus = String(pr.status || "").toUpperCase();

    if (prStatus === "FAILED") {
      await orderRef.update({
        paymentStatus: "failed",
        xenditPaymentStatus: "FAILED",
        paymentFailureCode: pr.failure_code || pr.error_code || null,
        paymentFailureReason:
          pr.failure_reason || pr.message || "Payment failed.",
        fulfillmentStatus: "pending",
        inventoryFulfilled: false,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return res.json({
        success: true,
        orderId: orderSnap.id,
        paymentStatus: "failed",
        xenditStatus: prStatus,
      });
    }

    if (prStatus !== "SUCCEEDED") {
      await orderRef.update({
        xenditPaymentStatus: prStatus || order.xenditPaymentStatus || "PENDING",
        updatedAt: FieldValue.serverTimestamp(),
      });

      return res.json({
        success: true,
        orderId: orderSnap.id,
        paymentStatus: order.paymentStatus || "pending",
        xenditStatus: prStatus,
      });
    }

    // Webhook-shaped data so the shared guards + fulfillment apply.
    const data = {
      payment_id: pr.latest_payment_id || pr.payment_id || null,
      payment_request_id:
        pr.payment_request_id || pr.id || paymentRequestId,
      reference_id:
        pr.reference_id || order.xenditReferenceId || order.orderNumber || null,
      channel_code: pr.channel_code || order.xenditPaymentChannel || "GCASH",
      status: "SUCCEEDED",
      request_amount: pr.request_amount,
      captures: Array.isArray(pr.captures) ? pr.captures : [],
      metadata: pr.metadata || {},
    };

    if (data.channel_code && data.channel_code !== "GCASH") {
      return res.status(400).json({
        success: false,
        error: "Unexpected payment channel.",
      });
    }

    const orderTotal = Number(order.total);
    const capturedAmount = getCapturedAmount(data);

    if (
      !Number.isFinite(orderTotal) ||
      !Number.isFinite(capturedAmount) ||
      Math.abs(orderTotal - capturedAmount) > 0.01
    ) {
      await recordPaidNeedsReview(
        orderRef,
        data,
        "manual_review",
        "Payment amount does not match the order total."
      );

      return res.json({
        success: true,
        orderId: orderSnap.id,
        paymentStatus: "manual_review",
        message: "Payment received but amount mismatch requires manual review.",
      });
    }

    const requestMismatch =
      order.xenditPaymentRequestId &&
      data.payment_request_id &&
      order.xenditPaymentRequestId !== data.payment_request_id;

    const referenceMismatch =
      order.xenditReferenceId &&
      data.reference_id &&
      order.xenditReferenceId !== data.reference_id;

    if (requestMismatch || referenceMismatch) {
      await recordPaidNeedsReview(
        orderRef,
        data,
        "manual_review",
        "Payment came from a different payment request than the one saved on the order."
      );

      return res.json({
        success: true,
        orderId: orderSnap.id,
        paymentStatus: "manual_review",
        message: "Payment received but request mismatch requires manual review.",
      });
    }

    if (order.status === "cancelled") {
      await recordPaidNeedsReview(
        orderRef,
        data,
        "manual_review",
        "Payment received after the order was cancelled."
      );

      return res.json({
        success: true,
        orderId: orderSnap.id,
        paymentStatus: "manual_review",
        message: "Payment received for cancelled order; manual review required.",
      });
    }

    try {
      const result = await fulfillPaidOrder(orderRef, data);

      await orderRef.update({
        xenditWebhookEvent: "payment.sync",
        updatedAt: FieldValue.serverTimestamp(),
      });

      return res.json({
        success: true,
        orderId: orderSnap.id,
        paymentStatus: "paid",
        inventoryFulfilled: true,
        alreadyFulfilled: result.alreadyFulfilled === true,
      });
    } catch (fulfillmentError) {
      if (
        fulfillmentError.code === "STOCK_UNAVAILABLE" ||
        fulfillmentError.code === "FULFILLMENT_BLOCKED"
      ) {
        await recordPaidNeedsReview(
          orderRef,
          data,
          fulfillmentError.code === "STOCK_UNAVAILABLE"
            ? "stock_unavailable"
            : "manual_review",
          fulfillmentError.message
        );

        return res.json({
          success: true,
          orderId: orderSnap.id,
          paymentStatus: "manual_review",
          message: "Payment received but order requires manual review.",
        });
      }

      throw fulfillmentError;
    }
  } catch (error) {
    console.error("PAYMENT SYNC ERROR:", error);

    return res.status(error.status || 500).json({
      success: false,
      error: error.message || "Unable to sync payment status.",
    });
  }
});

/* =========================================================
   XENDIT WEBHOOK
========================================================= */

app.post("/webhooks/xendit", async (req, res) => {
  try {
    const callbackToken = req.headers["x-callback-token"];
    const webhookToken = getEnv("XENDIT_WEBHOOK_TOKEN");

    if (!webhookToken) {
      console.error("XENDIT_WEBHOOK_TOKEN is missing.");

      return res.status(500).json({
        success: false,
        error: "Webhook token is not configured.",
      });
    }

    if (!callbackToken || typeof callbackToken !== "string") {
      console.error("Missing Xendit callback token.");

      return res.status(401).json({
        success: false,
        error: "Missing Xendit callback token.",
      });
    }

    if (!safeCompare(callbackToken, webhookToken)) {
      console.error("Invalid Xendit callback token.");

      return res.status(401).json({
        success: false,
        error: "Invalid Xendit callback token.",
      });
    }

    const event = req.body?.event;
    const data = req.body?.data || {};

    console.log("XENDIT WEBHOOK RECEIVED:", {
      event,
      paymentId: data.payment_id,
      paymentRequestId: data.payment_request_id,
      referenceId: data.reference_id,
      channel: data.channel_code,
      status: data.status,
      requestAmount: data.request_amount,
    });

    /* ---------- COMMISSION RESERVE DEPOSIT WEBHOOK ---------- */

    const depositWebhook = await handleCommissionDepositWebhook({
      db,
      event,
      data,
    });

    if (depositWebhook?.handled) {
      return res.status(200).json({
        success: true,
        message: depositWebhook?.failed
          ? "Commission reserve deposit payment failure recorded."
          : depositWebhook?.manualReview
            ? "Commission reserve deposit requires manual review."
            : "Commission reserve deposit webhook handled.",
        deposit: depositWebhook,
      });
    }

    /* ---------- AUTHORIZATION ---------- */

    if (event === "payment.authorization") {
      return res.status(200).json({
        success: true,
        message: "Payment authorization webhook acknowledged.",
      });
    }

    /* ---------- FAILURE ---------- */

    if (event === "payment.failure") {
      const orderSnap = await findOrderFromWebhook(data);

      if (!orderSnap) {
        console.error("ORDER NOT FOUND FOR PAYMENT FAILURE.");

        return res.status(200).json({
          success: true,
          message: "Webhook acknowledged; order not found.",
        });
      }

      const order = orderSnap.data();

      // A failure of an old attempt must never undo a paid order.
      if (order.paymentStatus === "paid") {
        return res.status(200).json({
          success: true,
          message: "Order is already paid.",
        });
      }

      await db.collection("orders").doc(orderSnap.id).update({
        paymentStatus: "failed",
        xenditPaymentId: data.payment_id || null,
        xenditPaymentRequestId: data.payment_request_id || null,
        xenditReferenceId: data.reference_id || null,
        xenditPaymentChannel: data.channel_code || "GCASH",
        xenditPaymentStatus: data.status || "FAILED",
        paymentFailureCode: data.failure_code || data.error_code || null,
        paymentFailureReason:
          data.failure_reason || data.failure_message || data.message || null,
        fulfillmentStatus: "pending",
        inventoryFulfilled: false,
        updatedAt: FieldValue.serverTimestamp(),
        xenditWebhookEvent: "payment.failure",
        xenditWebhookReceivedAt: FieldValue.serverTimestamp(),
      });

      console.log(`Payment failure saved for order ${orderSnap.id}`);

      return res.status(200).json({
        success: true,
        message: "Payment failure recorded.",
      });
    }

    /* ---------- ONLY payment.capture FULFILLS ---------- */

    if (event !== "payment.capture") {
      console.log("Webhook acknowledged; no fulfillment required:", event);

      return res.status(200).json({
        success: true,
        message: "Webhook acknowledged; no fulfillment required.",
      });
    }

    if (data.status !== "SUCCEEDED") {
      console.error("Payment capture is not successful:", data.status);

      return res.status(200).json({
        success: true,
        message: "Payment capture received but payment is not successful.",
      });
    }

    if (data.channel_code && data.channel_code !== "GCASH") {
      console.error("Unexpected payment channel:", data.channel_code);

      return res.status(400).json({
        success: false,
        error: "Unexpected payment channel.",
      });
    }

    const orderSnap = await findOrderFromWebhook(data);

    if (!orderSnap) {
      console.error("ORDER NOT FOUND FOR PAYMENT CAPTURE:", {
        paymentId: data.payment_id,
        paymentRequestId: data.payment_request_id,
        referenceId: data.reference_id,
      });

      return res.status(200).json({
        success: true,
        message: "Webhook acknowledged; order not found.",
      });
    }

    const orderRef = db.collection("orders").doc(orderSnap.id);
    const order = orderSnap.data();

    /* ---------- DUPLICATE PAYMENT FOR AN ALREADY-PAID ORDER ---------- */

    if (
      order.paymentStatus === "paid" &&
      order.xenditPaymentId &&
      data.payment_id &&
      order.xenditPaymentId !== data.payment_id
    ) {
      await orderRef.update({
        duplicatePaymentNeedsRefund: true,
        duplicatePaymentIds: FieldValue.arrayUnion(data.payment_id),
        updatedAt: FieldValue.serverTimestamp(),
      });

      console.warn(
        `Duplicate payment ${data.payment_id} for already-paid order ${orderSnap.id}. Refund required.`
      );

      return res.status(200).json({
        success: true,
        message: "Duplicate payment recorded for manual refund.",
      });
    }

    /* ---------- ALREADY FULFILLED (idempotent retry) ---------- */

    if (order.inventoryFulfilled === true && order.paymentStatus === "paid") {
      console.log(`Order ${orderSnap.id} already fulfilled.`);

      return res.status(200).json({
        success: true,
        message: "Order already fulfilled.",
        orderId: orderSnap.id,
        inventoryFulfilled: true,
        alreadyFulfilled: true,
      });
    }

    /* ---------- REQUEST / REFERENCE MISMATCH -> MANUAL REVIEW ---------- */
    /* Money arrived, so never answer 400 and lose track of it. */

    const requestMismatch =
      order.xenditPaymentRequestId &&
      data.payment_request_id &&
      order.xenditPaymentRequestId !== data.payment_request_id;

    const referenceMismatch =
      order.xenditReferenceId &&
      data.reference_id &&
      order.xenditReferenceId !== data.reference_id;

    if (requestMismatch || referenceMismatch) {
      await recordPaidNeedsReview(
        orderRef,
        data,
        "manual_review",
        "Payment came from a different payment request than the one saved on the order."
      );

      console.error("PAYMENT REQUEST/REFERENCE MISMATCH:", orderSnap.id);

      return res.status(200).json({
        success: true,
        message: "Payment received but request mismatch requires manual review.",
      });
    }

    /* ---------- AMOUNT CHECK ---------- */

    const orderTotal = Number(order.total);
    const capturedAmount = getCapturedAmount(data);

    if (!Number.isFinite(orderTotal) || !Number.isFinite(capturedAmount)) {
      await recordPaidNeedsReview(
        orderRef,
        data,
        "manual_review",
        "Invalid payment amount."
      );

      return res.status(200).json({
        success: true,
        message: "Payment received but amount is invalid; manual review required.",
      });
    }

    if (Math.abs(orderTotal - capturedAmount) > 0.01) {
      console.error("PAYMENT AMOUNT MISMATCH:", { orderTotal, capturedAmount });

      await recordPaidNeedsReview(
        orderRef,
        data,
        "manual_review",
        "Payment amount does not match the order total."
      );

      return res.status(200).json({
        success: true,
        message:
          "Payment received but amount mismatch requires manual review.",
      });
    }

    /* ---------- CANCELLED ORDER ---------- */

    if (order.status === "cancelled") {
      await recordPaidNeedsReview(
        orderRef,
        data,
        "manual_review",
        "Payment received after the order was cancelled."
      );

      console.warn(
        `Cancelled order ${orderSnap.id} received payment. Manual review required.`
      );

      return res.status(200).json({
        success: true,
        message:
          "Payment received for cancelled order; manual review required.",
      });
    }

    /* ---------- SERVER-SIDE FIFO FULFILLMENT ---------- */

    try {
      const result = await fulfillPaidOrder(orderRef, data);

      console.log("PAYMENT + FULFILLMENT COMPLETE:", {
        orderId: orderSnap.id,
        alreadyFulfilled: result.alreadyFulfilled,
      });

      return res.status(200).json({
        success: true,
        message: result.alreadyFulfilled
          ? "Order already fulfilled."
          : "Payment captured and inventory fulfilled.",
        orderId: orderSnap.id,
        inventoryFulfilled: true,
        alreadyFulfilled: result.alreadyFulfilled,
      });
    } catch (fulfillmentError) {
      if (
        fulfillmentError.code === "STOCK_UNAVAILABLE" ||
        fulfillmentError.code === "FULFILLMENT_BLOCKED"
      ) {
        await recordPaidNeedsReview(
          orderRef,
          data,
          fulfillmentError.code === "STOCK_UNAVAILABLE"
            ? "stock_unavailable"
            : "manual_review",
          fulfillmentError.message
        );

        console.error(
          "PAYMENT SUCCESS BUT FULFILLMENT BLOCKED:",
          fulfillmentError.message
        );

        // Payment succeeded, so acknowledge. The order is flagged for a human.
        return res.status(200).json({
          success: true,
          message: "Payment received but order requires manual review.",
          orderId: orderSnap.id,
        });
      }

      throw fulfillmentError;
    }
  } catch (error) {
    console.error("XENDIT WEBHOOK ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Webhook processing failed.",
    });
  }
});

/* =========================================================
   PAYMENT RESULT PAGES (all user input is HTML-escaped)
========================================================= */

const renderPaymentPage = ({ title, heading, lines, orderId }) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="font-family: Arial, sans-serif; text-align: center; padding: 40px;">
  <h2>${escapeHtml(heading)}</h2>
  ${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("\n  ")}
  ${orderId ? `<p>Order ID: <strong>${escapeHtml(orderId)}</strong></p>` : ""}
</body>
</html>`;

app.get("/payment/success", (req, res) => {
  const orderId = String(req.query.orderId || "");

  res.status(200).send(
    renderPaymentPage({
      title: "FarmGate Payment",
      heading: "Payment Submitted",
      lines: [
        "Your GCash payment has been submitted.",
        "FarmGate is waiting for the final payment confirmation.",
        "You can return to the FarmGate app.",
      ],
      orderId,
    })
  );
});

app.get("/payment/failure", (req, res) => {
  const orderId = String(req.query.orderId || "");

  res.status(200).send(
    renderPaymentPage({
      title: "FarmGate Payment Failed",
      heading: "Payment Failed",
      lines: [
        "The GCash payment was not completed.",
        "Return to FarmGate and try again.",
      ],
      orderId,
    })
  );
});

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found.",
    path: req.originalUrl,
  });
});

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
  console.error("GLOBAL ERROR:", error);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    success: false,
    error: error.message || "Internal server error.",
  });
});

/* =========================================================
   START SERVER
========================================================= */

const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("========================================");
  console.log(`FarmGate Backend running on port ${PORT}`);
  console.log(`Cloudinary configured: ${!!getEnv("CLOUD_NAME")}`);
  console.log(`Firebase configured: ${!!getEnv("FIREBASE_PROJECT_ID")}`);
  console.log(`Xendit configured: ${!!getEnv("XENDIT_SECRET_KEY")}`);
  console.log(`Xendit webhook configured: ${!!getEnv("XENDIT_WEBHOOK_TOKEN")}`);
  console.log(`Email (SMTP) configured: ${isSmtpConfigured()}`);
  console.log(`PUBLIC_BASE_URL: ${getEnv("PUBLIC_BASE_URL") || "NOT SET"}`);
  console.log("========================================");
});