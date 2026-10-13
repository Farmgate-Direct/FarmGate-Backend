// Calibration helper: OSRM road distance for 8 real Bulacan routes.
// Pins come from data/bulacanBarangays.js (verified OSM coordinates).
// Usage: node scripts/calibrate-osrm.js
// Fill the Google Maps column manually, then compare. Re-run after every
// extract rebuild (osrm/README.md).
"use strict";
const { getRouteDistanceKm, getBaseUrl, getDataVersion } = require("../osrmClient");
const { BARANGAY_COORDS } = require("../data/bulacanBarangays");

const norm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
const pin = (city, barangay) => {
  const hit = BARANGAY_COORDS[`${norm(city)}|${norm(barangay)}`];
  if (!hit) throw new Error(`No coords for ${city} | ${barangay}`);
  return { lat: hit.lat, lng: hit.lng };
};

const ROUTES = [
  ["Malolos", "Santo Niño (Pob.)", "Guiguinto", "Poblacion"],
  ["Hagonoy", "San Isidro", "Hagonoy", "Iba"],
  ["Malolos", "Santo Niño (Pob.)", "San Miguel", "Poblacion"],
  ["San Jose del Monte", "Sapang Palay", "San Jose del Monte", "Muzon"],
  ["Santa Maria", "Poblacion", "Santa Maria", "Pulong Buhangin"],
  ["Norzagaray", "Poblacion", "Norzagaray", "Bigte"],
  ["Baliwag", "Poblacion", "Pulilan", "Poblacion"],
  ["Calumpit", "Poblacion", "Malolos", "Santo Niño (Pob.)"],
];

async function main() {
  console.log(`OSRM ${getBaseUrl()} dataVersion=${getDataVersion()}`);
  console.log("| route | OSRM km | Google Maps km | diff |");
  console.log("|---|---|---|---|");
  for (const [c1, b1, c2, b2] of ROUTES) {
    const a = pin(c1, b1);
    const b = pin(c2, b2);
    try {
      const r = await getRouteDistanceKm(a, b);
      console.log(`| ${c1} ${b1} → ${c2} ${b2} | ${r.distanceKm} |  |  |`);
    } catch (e) {
      console.log(`| ${c1} ${b1} → ${c2} ${b2} | ERROR ${e?.code || ""} ${e?.message || ""} |  |  |`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
