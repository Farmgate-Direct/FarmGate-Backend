// OSRM health check: one known intra-Bulacan route must return code "Ok".
// Usage: node scripts/osrm-healthcheck.js
// Exit 0 = healthy, 1 = page someone. Wire to cron (every 5 min).
"use strict";
const { checkHealth, getBaseUrl, getDataVersion } = require("../osrmClient");

async function main() {
  const started = Date.now();
  try {
    const r = await checkHealth();
    console.log(
      JSON.stringify({
        ok: true,
        baseUrl: getBaseUrl(),
        dataVersion: getDataVersion(),
        code: r.code,
        distanceKm: r.distanceKm,
        ms: Date.now() - started,
      })
    );
  } catch (e) {
    console.error(
      JSON.stringify({
        ok: false,
        baseUrl: getBaseUrl(),
        dataVersion: getDataVersion(),
        code: e?.code || "ERROR",
        error: e?.message || String(e),
        ms: Date.now() - started,
      })
    );
    process.exit(1);
  }
}

main();
