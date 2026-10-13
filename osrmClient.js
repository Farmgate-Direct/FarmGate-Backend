// OSRM distance client — self-hosted instance only (see osrm/README.md).
//
// Privacy: coordinates never leave our infrastructure. OSRM is bound to
// 127.0.0.1 (or a private port) and ONLY this backend module may call it.
// The mobile client never calls OSRM directly.
//
//   GET {OSRM_BASE_URL}/route/v1/driving/{farmLng},{farmLat};{buyerLng},{buyerLat}?overview=false
//
// Rules (never estimate):
// - code NoRoute / NoSegment / missing routes -> OsrmError NO_ROUTE (blocked).
// - 3s timeout, retry ONCE on network error/timeout/malformed; second
//   failure -> OsrmError UNAVAILABLE (retryable, order stays pending).
// - Same pin (identical coordinates) -> 0 km WITHOUT calling OSRM.
// - Logs request time + result code. Raw coordinates are NEVER logged
//   at info level.
"use strict";

const { roundDistanceKm } = require("./deliveryFee");

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_BASE_URL = "http://127.0.0.1:5000";

class OsrmError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OsrmError";
    this.code = code;
  }
}

function getBaseUrl(env = process.env) {
  const raw = env && env.OSRM_BASE_URL ? String(env.OSRM_BASE_URL).trim() : "";
  return (raw || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

// Dataset version recorded on every order (cache key + fixed record).
function getDataVersion(env = process.env) {
  const raw = env && env.OSRM_DATA_VERSION ? String(env.OSRM_DATA_VERSION).trim() : "";
  return raw || "dev";
}

function defaultLogger() {
  return {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fetch with a timeout that works even if the fetch impl ignores signals.
async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isTimeoutError(e) {
  return (
    e?.name === "AbortError" ||
    e?.name === "TimeoutError" ||
    String(e?.message || "").toLowerCase().includes("abort")
  );
}

// farmPin / buyerPin: { lat, lng } numbers (already validated).
// opts: { fetchImpl, timeoutMs, env, logger }
// Returns { distanceKm, osrmDataVersion }. Throws OsrmError.
async function getRouteDistanceKm(farmPin, buyerPin, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const env = opts.env || process.env;
  const logger = opts.logger || defaultLogger();
  const baseUrl = getBaseUrl(env);
  const osrmDataVersion = getDataVersion(env);

  const flat = Number(farmPin?.lat);
  const flng = Number(farmPin?.lng);
  const blat = Number(buyerPin?.lat);
  const blng = Number(buyerPin?.lng);

  // Same pin: 0 km, no OSRM call needed.
  if (flat === blat && flng === blng) {
    return { distanceKm: 0, osrmDataVersion };
  }

  const url =
    `${baseUrl}/route/v1/driving/` +
    `${flng},${flat};${blng},${blat}?overview=false`;

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    try {
      const res = await fetchWithTimeout(fetchImpl, url, timeoutMs);
      if (!res || res.ok === false) {
        throw new Error(`OSRM HTTP ${res ? res.status : "no-response"}`);
      }
      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error("OSRM malformed JSON");
      }
      const ms = Date.now() - started;
      const code = data?.code;
      const distance = data?.routes?.[0]?.distance;

      if (code === "NoRoute" || code === "NoSegment" || !Array.isArray(data?.routes) || data.routes.length === 0) {
        // Definitive: no road connects these pins. No retry, no estimate.
        logger.info(`osrm route code=${code || "empty"} attempt=${attempt} ms=${ms}`);
        throw new OsrmError(
          "NO_ROUTE",
          "No driving route between the farm and this address. Delivery is blocked — ask the farmer about this area."
        );
      }

      if (!Number.isFinite(Number(distance))) {
        throw new Error("OSRM missing distance");
      }

      const distanceKm = roundDistanceKm(distance);
      logger.info(`osrm route code=Ok attempt=${attempt} ms=${ms} distanceKm=${distanceKm}`);
      return { distanceKm, osrmDataVersion };
    } catch (e) {
      const ms = Date.now() - started;
      if (e instanceof OsrmError) throw e; // NO_ROUTE: definitive, no retry.
      lastError = e;
      const kind = isTimeoutError(e) ? "timeout" : "network";
      logger.warn(`osrm route ${kind} attempt=${attempt} ms=${ms}`);
      if (attempt === 1) {
        await sleep(150);
        continue; // retry once
      }
      throw new OsrmError(
        "UNAVAILABLE",
        "Could not reach the routing service. Your order stays pending — please tap Try again."
      );
    }
  }
  throw new OsrmError(
    "UNAVAILABLE",
    "Could not reach the routing service. Your order stays pending — please tap Try again."
  );
}

// Smoke test for the local instance: calls one known intra-Bulacan route
// and requires code === "Ok" plus a positive distance.
async function checkHealth(opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const env = opts.env || process.env;
  const baseUrl = getBaseUrl(env);
  // Fixed smoke-test pins (Malolos <-> Guiguinto, both inside the extract).
  const url =
    `${baseUrl}/route/v1/driving/` +
    `120.8107,14.841;120.8798,14.8298?overview=false`;
  const started = Date.now();
  const res = await fetchWithTimeout(fetchImpl, url, timeoutMs);
  if (!res || res.ok === false) {
    throw new OsrmError("UNAVAILABLE", `OSRM health HTTP ${res ? res.status : "no-response"}`);
  }
  const data = await res.json();
  const ms = Date.now() - started;
  if (data?.code !== "Ok" || !Number.isFinite(Number(data?.routes?.[0]?.distance))) {
    throw new OsrmError("UNAVAILABLE", `OSRM health bad payload (code=${data?.code})`);
  }
  return { ok: true, ms, code: data.code, distanceKm: roundDistanceKm(data.routes[0].distance) };
}

module.exports = {
  OsrmError,
  getRouteDistanceKm,
  checkHealth,
  getBaseUrl,
  getDataVersion,
  DEFAULT_TIMEOUT_MS,
};
