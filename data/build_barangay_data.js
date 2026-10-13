// Turns bulacan_barangays.csv (city,barangay,lat,lng) into a JS module.
// STRICT (Bulacan-only, complete dataset required):
// - FAILS (exit 1) if row count is not 569.
// - FAILS if any coordinate is missing/non-numeric.
// - FAILS if any coordinate is outside Bulacan's bounding box (or 0,0).
// - FAILS if any normalized (city, barangay) key is duplicated.
// - No guessing, no city-center substitution, no approximate fallback.
//   If any barangay cannot be sourced with reliable coordinates, stop and
//   report the exact names instead of shipping a partial dataset.
//
// Writes bulacanBarangays.js with: BARANGAY_COORDS, CITIES, BARANGAYS_BY_CITY.
//
// Usage:
//   node data/build_barangay_data.js [--check-only]
"use strict";
const fs = require("fs");
const path = require("path");

const CSV_PATH = path.join(__dirname, "bulacan_barangays.csv");
const OUT_PATH = path.join(__dirname, "bulacanBarangays.js");

const EXPECTED_ROWS = 569;

// Bulacan bounding box (Central Luzon). Anything outside is rejected.
const BBOX = { minLat: 14.4, maxLat: 15.4, minLng: 120.5, maxLng: 121.4 };

const normalize = (s) =>
  String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

function parseCsv(text) {
  // Minimal CSV parser supporting quoted fields with commas/quotes.
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // skip, handled by \n
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => String(f).trim() !== ""));
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function main() {
  const checkOnly = process.argv.includes("--check-only");
  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const rows = parseCsv(raw);
  if (rows.length < 2) {
    fail("CSV is empty or missing header.");
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const ci = header.indexOf("city");
  const bi = header.indexOf("barangay");
  const la = header.indexOf("lat");
  const ln = header.indexOf("lng");
  if (ci < 0 || bi < 0 || la < 0 || ln < 0) {
    fail("CSV header must be: city,barangay,lat,lng");
  }

  const dataRows = rows.length - 1;
  if (dataRows !== EXPECTED_ROWS) {
    fail(
      `Row count mismatch: expected ${EXPECTED_ROWS} barangays, found ${dataRows}. ` +
        `Do not ship a partial dataset — source every Bulacan barangay first.`
    );
  }

  const seen = new Map(); // normalized key -> line number
  const coords = {}; // "city|barangay" normalized -> { city, barangay, lat, lng }
  const citiesSet = new Map(); // normalized city -> display name
  const byCity = new Map(); // normalized city -> [{ barangay, lat, lng, hasCoords }]

  const missing = [];
  const outOfBox = [];
  const duplicates = [];

  for (let i = 1; i < rows.length; i++) {
    const line = i + 1;
    const cityDisp = String(rows[i][ci] || "").trim().replace(/\s+/g, " ");
    const brgyDisp = String(rows[i][bi] || "").trim().replace(/\s+/g, " ");
    const latRaw = String(rows[i][la] || "").trim();
    const lngRaw = String(rows[i][ln] || "").trim();

    if (!cityDisp || !brgyDisp) {
      fail(`Line ${line}: empty city or barangay.`);
    }
    const nCity = normalize(cityDisp);
    const nBrgy = normalize(brgyDisp);
    const key = `${nCity}|${nBrgy}`;

    if (seen.has(key)) {
      duplicates.push(
        `Line ${line}: duplicate (city,barangay) key "${cityDisp} | ${brgyDisp}" (first at line ${seen.get(key)})`
      );
      continue;
    }
    seen.set(key, line);

    if (!citiesSet.has(nCity)) citiesSet.set(nCity, cityDisp);
    if (!byCity.has(nCity)) byCity.set(nCity, []);

    const lat = latRaw === "" ? NaN : Number(latRaw);
    const lng = lngRaw === "" ? NaN : Number(lngRaw);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      missing.push(`${cityDisp} | ${brgyDisp} (line ${line})`);
      byCity.get(nCity).push({ barangay: brgyDisp, lat: null, lng: null, hasCoords: false });
      continue;
    }

    const reasons = [];
    if (lat === 0 && lng === 0) reasons.push("0,0 null island");
    if (lat < BBOX.minLat || lat > BBOX.maxLat || lng < BBOX.minLng || lng > BBOX.maxLng)
      reasons.push(`outside Bulacan bbox (${lat},${lng}) — bbox lat [${BBOX.minLat},${BBOX.maxLat}] lng [${BBOX.minLng},${BBOX.maxLng}]`);

    if (reasons.length > 0) {
      outOfBox.push(`${cityDisp} | ${brgyDisp} (${lat},${lng}) — ${reasons.join("; ")} (line ${line})`);
      byCity.get(nCity).push({ barangay: brgyDisp, lat, lng, hasCoords: false });
      continue;
    }

    coords[key] = { city: cityDisp, barangay: brgyDisp, lat, lng };
    byCity.get(nCity).push({ barangay: brgyDisp, lat, lng, hasCoords: true });
  }

  console.log(`Parsed ${seen.size} rows from bulacan_barangays.csv`);
  console.log(`  with coords: ${Object.keys(coords).length}`);
  console.log(`  missing coords: ${missing.length}`);
  console.log(`  outside bbox: ${outOfBox.length}`);
  console.log(`  duplicate keys: ${duplicates.length}`);

  let failed = false;
  if (duplicates.length > 0) {
    console.error("\nDUPLICATE (city,barangay) KEYS — fix CSV, keys must be unique:");
    for (const d of duplicates) console.error("  " + d);
    failed = true;
  }
  if (missing.length > 0) {
    console.error("\nMISSING coordinates — build FAILED. Source reliable coordinates, do not guess:");
    for (const m of missing.slice(0, 100)) console.error("  " + m);
    if (missing.length > 100) console.error(`  ... and ${missing.length - 100} more`);
    failed = true;
  }
  if (outOfBox.length > 0) {
    console.error("\nCOORDINATES OUTSIDE BULACAN BBOX — build FAILED. Verify in the field:");
    for (const s of outOfBox) console.error("  " + s);
    failed = true;
  }
  if (failed) {
    console.error("\nBUILD FAILED: dataset is incomplete or invalid. No JS module was written.");
    process.exit(1);
  }

  // Sort cities and barangays for stable output
  const cities = Array.from(citiesSet.values()).sort((a, b) => a.localeCompare(b));
  const barangaysByCity = {};
  for (const [nCity, list] of byCity.entries()) {
    const disp = citiesSet.get(nCity);
    list.sort((a, b) => a.barangay.localeCompare(b.barangay));
    barangaysByCity[disp] = list;
  }

  if (checkOnly) {
    console.log(`\nCHECK OK: ${seen.size} rows, all with valid in-bbox coordinates, no duplicates.`);
    return;
  }

  const out =
    `// AUTO-GENERATED by data/build_barangay_data.js — do not edit by hand.\n` +
    `// Source: data/bulacan_barangays.csv (${seen.size} rows, ${Object.keys(coords).length} routable, 0 approximate).\n` +
    `"use strict";\n\n` +
    `const BARANGAY_COORDS = ${JSON.stringify(coords, null, 2)};\n\n` +
    `const CITIES = ${JSON.stringify(cities, null, 2)};\n\n` +
    `const BARANGAYS_BY_CITY = ${JSON.stringify(barangaysByCity, null, 2)};\n\n` +
    `module.exports = { BARANGAY_COORDS, CITIES, BARANGAYS_BY_CITY };\n`;

  fs.writeFileSync(OUT_PATH, out);
  console.log(`\nWrote ${OUT_PATH}`);
}

main();
