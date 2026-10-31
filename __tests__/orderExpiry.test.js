const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AUTOMATIC_CANCELLATION_MESSAGE,
  ORDER_ACCEPTANCE_TIMEOUT_MS,
  createOrderChatId,
  isExpiredPendingOrder,
  processExpiredPendingOrders,
} = require("../orderExpiry");

const now = Date.UTC(2026, 9, 31, 8, 0, 0);

test("pending order expires at the 48-hour boundary", () => {
  assert.equal(
    isExpiredPendingOrder(
      {
        status: "pending",
        createdAt: now - ORDER_ACCEPTANCE_TIMEOUT_MS,
      },
      now
    ),
    true
  );
  assert.equal(
    isExpiredPendingOrder(
      {
        status: "pending",
        createdAt: now - ORDER_ACCEPTANCE_TIMEOUT_MS + 1,
      },
      now
    ),
    false
  );
});

test("accepted, manually cancelled, paid, and already auto-cancelled orders are kept", () => {
  const expiredAt = now - ORDER_ACCEPTANCE_TIMEOUT_MS;
  for (const order of [
    { status: "accepted" },
    { status: "cancelled" },
    { status: "pending", paymentStatus: "paid" },
    { status: "pending", autoCancelled: true },
    { status: "pending", createdAt: null },
  ]) {
    assert.equal(
      isExpiredPendingOrder({ createdAt: expiredAt, ...order }, now),
      false
    );
  }
});

test("order chat id is stable regardless of participant order", () => {
  assert.equal(createOrderChatId("buyer-1", "farmer-2"), "buyer-1_farmer-2");
  assert.equal(createOrderChatId("farmer-2", "buyer-1"), "buyer-1_farmer-2");
});

test("automatic cancellation system message is fixed", () => {
  assert.equal(
    AUTOMATIC_CANCELLATION_MESSAGE,
    "This order was automatically cancelled because the farmer did not accept it within 2 days."
  );
});

class FakeSnapshot {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = data !== undefined;
    this.value = data;
    this.size = undefined;
  }

  data() {
    return this.value;
  }
}

class FakeReference {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = path.split("/").at(-1);
  }

  async get() {
    return new FakeSnapshot(this, this.db.records.get(this.path));
  }

  collection(name) {
    return new FakeCollection(this.db, `${this.path}/${name}`);
  }
}

class FakeCollection {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  doc(id) {
    return new FakeReference(this.db, `${this.path}/${id}`);
  }

  where(field, operator, value) {
    return new FakeQuery(this.db, this.path, [[field, operator, value]]);
  }
}

class FakeQuery {
  constructor(db, path, filters = [], pageSize = Infinity, afterId = "") {
    this.db = db;
    this.path = path;
    this.filters = filters;
    this.pageSize = pageSize;
    this.afterId = afterId;
  }

  where(field, operator, value) {
    return new FakeQuery(
      this.db,
      this.path,
      [...this.filters, [field, operator, value]],
      this.pageSize,
      this.afterId
    );
  }

  limit(size) {
    return new FakeQuery(this.db, this.path, this.filters, size, this.afterId);
  }

  startAfter(snapshot) {
    return new FakeQuery(
      this.db,
      this.path,
      this.filters,
      this.pageSize,
      snapshot.id
    );
  }

  async get() {
    const docs = [...this.db.records.entries()]
      .filter(([path]) => path.startsWith(`${this.path}/`))
      .filter(([path]) => !path.slice(this.path.length + 1).includes("/"))
      .filter(([, data]) =>
        this.filters.every(([field, operator, value]) => {
          if (operator !== "==") throw new Error("Unsupported fake query operator");
          return data[field] === value;
        })
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .filter(([path]) => path.slice(this.path.length + 1) > this.afterId)
      .slice(0, this.pageSize)
      .map(([path, data]) => new FakeSnapshot(new FakeReference(this.db, path), data));

    return { docs, size: docs.length };
  }
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
  }

  async get(ref) {
    return ref.get();
  }

  update(ref, data) {
    this.db.records.set(ref.path, {
      ...this.db.records.get(ref.path),
      ...data,
    });
  }

  create(ref, data) {
    if (this.db.records.has(ref.path)) {
      const error = new Error("Already exists");
      error.code = 6;
      throw error;
    }
    this.db.records.set(ref.path, data);
  }
}

class FakeFirestore {
  constructor(records = {}) {
    this.records = new Map(Object.entries(records));
    this.beforeTransaction = null;
  }

  collection(name) {
    return new FakeCollection(this, name);
  }

  async runTransaction(callback) {
    if (this.beforeTransaction) {
      this.beforeTransaction();
      this.beforeTransaction = null;
    }
    return callback(new FakeTransaction(this));
  }
}

test("expired pending orders are cancelled once with recipient notices and chat system message", async () => {
  const db = new FakeFirestore({
    "orders/expired": {
      status: "pending",
      createdAt: new Date(now - ORDER_ACCEPTANCE_TIMEOUT_MS),
      buyerId: "buyer-1",
      farmerId: "farmer-2",
      payment: "cod",
    },
    "chats/buyer-1_farmer-2": { users: ["buyer-1", "farmer-2"] },
  });

  const firstRun = await processExpiredPendingOrders(db, { nowMs: now });
  const order = db.records.get("orders/expired");
  assert.equal(firstRun.cancelled, 1);
  assert.equal(order.status, "cancelled");
  assert.equal(order.autoCancelled, true);
  assert.equal(order.cancelReason, AUTOMATIC_CANCELLATION_MESSAGE);
  assert.equal(
    db.records.get("notifications/auto-cancel-expired-buyer").title,
    "Order Automatically Cancelled"
  );
  assert.equal(
    db.records.get("notifications/auto-cancel-expired-farmer").farmerId,
    "farmer-2"
  );
  assert.equal(
    db.records.get(
      `chats/buyer-1_farmer-2/messages/order-auto-cancelled-expired`
    ).text,
    AUTOMATIC_CANCELLATION_MESSAGE
  );

  const secondRun = await processExpiredPendingOrders(db, { nowMs: now });
  assert.equal(secondRun.cancelled, 0);
  assert.equal(db.records.size, 5);
});

test("accepted-at-deadline and not-yet-expired orders are not cancelled", async () => {
  const db = new FakeFirestore({
    "orders/accept-race": {
      status: "pending",
      createdAt: new Date(now - ORDER_ACCEPTANCE_TIMEOUT_MS),
      buyerId: "buyer-1",
      farmerId: "farmer-2",
    },
    "orders/not-expired": {
      status: "pending",
      createdAt: new Date(now - ORDER_ACCEPTANCE_TIMEOUT_MS + 1),
      buyerId: "buyer-1",
      farmerId: "farmer-2",
    },
  });
  db.beforeTransaction = () => {
    db.records.set("orders/accept-race", {
      ...db.records.get("orders/accept-race"),
      status: "accepted",
    });
  };

  const result = await processExpiredPendingOrders(db, { nowMs: now });
  assert.equal(result.cancelled, 0);
  assert.equal(db.records.get("orders/accept-race").status, "accepted");
  assert.equal(db.records.get("orders/not-expired").status, "pending");
  assert.equal(db.records.has("notifications/auto-cancel-accept-race-buyer"), false);
});

test("manually cancelled orders are never candidates for automatic cancellation", async () => {
  const db = new FakeFirestore({
    "orders/manual": {
      status: "cancelled",
      createdAt: new Date(now - ORDER_ACCEPTANCE_TIMEOUT_MS),
      buyerId: "buyer-1",
      farmerId: "farmer-2",
    },
  });

  const result = await processExpiredPendingOrders(db, { nowMs: now });
  assert.equal(result.scanned, 0);
  assert.equal(result.cancelled, 0);
});
