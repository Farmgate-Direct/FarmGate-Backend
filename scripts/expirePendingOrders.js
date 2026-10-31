const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { processExpiredPendingOrders } = require("../orderExpiry");

async function main() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountJson) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not configured.");
  }

  const serviceAccount = JSON.parse(serviceAccountJson);
  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }

  const result = await processExpiredPendingOrders(getFirestore());
  console.log("Expired order scan completed:", result);
  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("EXPIRED ORDER SCAN FAILED:", error);
  process.exitCode = 1;
});
