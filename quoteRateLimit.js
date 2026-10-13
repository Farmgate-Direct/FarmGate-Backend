// Per-user rate limit for the delivery quote endpoint so one client
// cannot spam OSRM. In-memory fixed window (single instance).
// 429 + Retry-After when exceeded.
"use strict";

const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_MS = 60 * 1000;

const buckets = new Map(); // uid -> { count, resetAt }

function checkQuoteRateLimit(uid, opts = {}) {
  const limit = opts.limit || DEFAULT_LIMIT;
  const windowMs = opts.windowMs || DEFAULT_WINDOW_MS;
  const now = opts.now || Date.now();
  const key = String(uid || "anonymous");
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > limit) {
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, b.resetAt - now) };
  }
  return { allowed: true, remaining: limit - b.count, retryAfterMs: 0 };
}

function resetQuoteRateLimits() {
  buckets.clear();
}

module.exports = { checkQuoteRateLimit, resetQuoteRateLimits, DEFAULT_LIMIT, DEFAULT_WINDOW_MS };
