// deliveryDistanceCache — Firestore-backed OSRM result cache.
//
// Collection: deliveryDistanceCache
// Key = sorted rounded pair (4 decimals × 4 numbers) + OSRM_DATA_VERSION,
// so A→B and B→A share one entry (driving distance is used either way).
// Record: { distanceKm, cachedAt (millis), osrmDataVersion, method: "osrm" }.
// Entries expire after 30 days. Best-effort: cache failures never fail
// the quote — the caller just calls OSRM directly.
"use strict";

const COLLECTION = "deliveryDistanceCache";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const fmt = (n) => Number(n).toFixed(4);

// Pure + unit-tested: same pair in either order gives the same key,
// and a new OSRM_DATA_VERSION gives a different key (cache miss).
function cacheKeyFor(farmPin, buyerPin, dataVersion) {
  const a = `${fmt(farmPin.lat)},${fmt(farmPin.lng)}`;
  const b = `${fmt(buyerPin.lat)},${fmt(buyerPin.lng)}`;
  const [first, second] = a <= b ? [a, b] : [b, a];
  return `${first}|${second}@${String(dataVersion || "dev")}`;
}

function cachedAtMillis(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isFresh(record, now = Date.now()) {
  if (!record || !Number.isFinite(Number(record.distanceKm))) return false;
  if (Number(record.distanceKm) < 0) return false;
  const age = now - cachedAtMillis(record.cachedAt);
  return age >= 0 && age <= THIRTY_DAYS_MS;
}

// Direct (non-transactional) read. Returns the record or null.
async function readCache(db, key, now = Date.now()) {
  try {
    const snap = await db.collection(COLLECTION).doc(key).get();
    if (!snap || snap.exists !== true) return null;
    const record = snap.data() || {};
    return isFresh(record, now) ? record : null;
  } catch {
    return null; // cache must never break quoting
  }
}

// Transactional read (for accept / create-payment). Returns record or null.
async function readCacheTx(transaction, db, key, now = Date.now()) {
  try {
    const ref = db.collection(COLLECTION).doc(key);
    const snap = await transaction.get(ref);
    if (!snap || snap.exists !== true) return null;
    const record = snap.data() || {};
    return isFresh(record, now) ? record : null;
  } catch {
    return null;
  }
}

// Direct write (fire-and-forget from the caller's perspective).
async function writeCache(db, key, { distanceKm, osrmDataVersion }) {
  try {
    await db
      .collection(COLLECTION)
      .doc(key)
      .set({
        distanceKm,
        cachedAt: Date.now(),
        osrmDataVersion: osrmDataVersion || "dev",
        method: "osrm",
      });
  } catch {
    // ignore — cache is best-effort
  }
}

module.exports = {
  COLLECTION,
  THIRTY_DAYS_MS,
  cacheKeyFor,
  isFresh,
  readCache,
  readCacheTx,
  writeCache,
};
