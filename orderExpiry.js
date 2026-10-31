const { FieldValue } = require("firebase-admin/firestore");

const ORDER_ACCEPTANCE_TIMEOUT_MS = 48 * 60 * 60 * 1000;
const AUTOMATIC_CANCELLATION_MESSAGE =
  "This order was automatically cancelled because the farmer did not accept it within 2 days.";

const timestampMillis = (value) => {
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return 0;
};

const isExpiredPendingOrder = (order, nowMs = Date.now()) =>
  order?.status === "pending" &&
  order.autoCancelled !== true &&
  order.paymentStatus !== "paid" &&
  timestampMillis(order.createdAt) > 0 &&
  timestampMillis(order.createdAt) <= nowMs - ORDER_ACCEPTANCE_TIMEOUT_MS;

const createOrderChatId = (buyerId, farmerId) =>
  [buyerId, farmerId].sort().join("_");

async function cancelIfStillPending(db, orderRef, nowMs) {
  return db.runTransaction(async (transaction) => {
    const orderSnapshot = await transaction.get(orderRef);
    if (!orderSnapshot.exists) return false;

    const order = orderSnapshot.data();
    if (!isExpiredPendingOrder(order, nowMs)) return false;

    if (!order.buyerId || !order.farmerId) {
      throw new Error(`Expired order ${orderRef.id} is missing a participant ID.`);
    }

    const buyerNotificationRef = db
      .collection("notifications")
      .doc(`auto-cancel-${orderRef.id}-buyer`);
    const farmerNotificationRef = db
      .collection("notifications")
      .doc(`auto-cancel-${orderRef.id}-farmer`);
    const buyerNotificationSnapshot = await transaction.get(
      buyerNotificationRef
    );
    const farmerNotificationSnapshot = await transaction.get(
      farmerNotificationRef
    );

    const chatRef = db
      .collection("chats")
      .doc(createOrderChatId(order.buyerId, order.farmerId));
    const chatSnapshot = await transaction.get(chatRef);
    const systemMessageRef = chatRef
      .collection("messages")
      .doc(`order-auto-cancelled-${orderRef.id}`);
    const systemMessageSnapshot = chatSnapshot.exists
      ? await transaction.get(systemMessageRef)
      : null;

    const now = FieldValue.serverTimestamp();
    transaction.update(orderRef, {
      status: "cancelled",
      autoCancelled: true,
      autoCancellationMessage: AUTOMATIC_CANCELLATION_MESSAGE,
      autoCancelledAt: now,
      cancelledAt: now,
      cancelledBy: "system",
      cancelReason: AUTOMATIC_CANCELLATION_MESSAGE,
      paymentStatus:
        order.payment === "gcash"
          ? "cancelled"
          : order.paymentStatus || "pending",
      updatedAt: now,
    });

    if (!buyerNotificationSnapshot.exists) {
      transaction.create(buyerNotificationRef, {
        userId: order.buyerId,
        kind: "system",
        title: "Order Automatically Cancelled",
        body: "Your order has been automatically cancelled because the farmer did not accept it within 2 days.",
        orderId: orderRef.id,
        read: false,
        createdAt: now,
      });
    }

    if (!farmerNotificationSnapshot.exists) {
      transaction.create(farmerNotificationRef, {
        farmerId: order.farmerId,
        kind: "system",
        title: "Order Automatically Cancelled",
        body: "An order was automatically cancelled because it was not accepted within 2 days.",
        orderId: orderRef.id,
        read: false,
        createdAt: now,
      });
    }

    if (chatSnapshot.exists && !systemMessageSnapshot.exists) {
      transaction.create(systemMessageRef, {
        type: "system",
        senderId: "system",
        receiverId: "",
        orderId: orderRef.id,
        text: AUTOMATIC_CANCELLATION_MESSAGE,
        createdAt: now,
      });
    }

    return true;
  });
}

async function processExpiredPendingOrders(db, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const batchSize = options.batchSize ?? 200;
  const baseQuery = db
    .collection("orders")
    .where("status", "==", "pending");

  let pageQuery = baseQuery.limit(batchSize);
  let scanned = 0;
  let cancelled = 0;
  let failed = 0;

  while (true) {
    const page = await pageQuery.get();
    scanned += page.size;

    for (const orderSnapshot of page.docs) {
      try {
        if (await cancelIfStillPending(db, orderSnapshot.ref, nowMs)) {
          cancelled += 1;
        }
      } catch (error) {
        failed += 1;
        console.error("AUTO-CANCEL ORDER ERROR:", {
          orderId: orderSnapshot.id,
          error,
        });
      }
    }

    if (page.size < batchSize) break;
    pageQuery = baseQuery.startAfter(page.docs[page.docs.length - 1]).limit(batchSize);
  }

  return { scanned, cancelled, failed };
}

module.exports = {
  AUTOMATIC_CANCELLATION_MESSAGE,
  ORDER_ACCEPTANCE_TIMEOUT_MS,
  createOrderChatId,
  isExpiredPendingOrder,
  processExpiredPendingOrders,
  timestampMillis,
};
