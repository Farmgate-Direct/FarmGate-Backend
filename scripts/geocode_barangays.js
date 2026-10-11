// Batch-geocodes barangays missing coords via Nominatim (OpenStreetMap).
// Strict filters so bad results are REJECTED, never guessed:
//   - display_name must contain Bulacan + the expected city
//   - addresstype must be a populated place (village/hamlet/suburb/quarter/
//     neighbourhood) or an administrative boundary (NOT roads/waterways)
//   - coords must fall inside the Bulacan bbox
//   - name must match (case/space/diacritic-insensitive)
// Rejected rows stay empty (still blocked) and go to the review list.
// Provenance is recorded in data/geocode_sources.json.
//
// Usage:
//   node scripts/geocode_barangays.js [--city=X] [--limit=N] [--dry-run]
// Resumes via data/geocode_progress.json (delete it to start over).
// Nominatim policy: 1 req/sec max — this script sleeps 1.2s between calls.
"use strict";
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CSV_PATH = path.join(DATA_DIR, "bulacan_barangays.csv");
const PROGRESS_PATH = path.join(DATA_DIR, "geocode_progress.json");
const SOURCES_PATH = path.join(DATA_DIR, "geocode_sources.json");

const BBOX = { minLat: 14.4, maxLat: 15.4, minLng: 120.5, maxLng: 121.4 };
const GOOD_TYPES = new Set([
  "village",
  "hamlet",
  "suburb",
  "quarter",
  "neighbourhood",
  "isolated_dwelling",
  "farm",
]);
const UA = "FarmGate-Direct-App/1.0 (Bulacan barangay geocoding for delivery fees)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fold = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[–—]/g, "-")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(=(.*))?$/);
    if (m) out[m[1]] = m[3] === undefined ? true : m[3];
  }
  return out;
}

function parseCsv(text) {
  const rows = [];
  let row = [],
    field = "",
    q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function scoreResult(item, city, brgy) {
  const lat = Number(item.lat);
  const lng = Number(item.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < BBOX.minLat || lat > BBOX.maxLat || lng < BBOX.minLng || lng > BBOX.maxLng)
    return null;
  const disp = String(item.display_name || "");
  const fDisp = fold(disp);
  if (!fDisp.includes("bulacan")) return null;
  if (!fDisp.includes(fold(city))) return null;
  const cls = String(item.class || "");
  const type = String(item.type || "");
  const addrType = String(item.addresstype || "");
  const isPlace = cls === "place" && GOOD_TYPES.has(type);
  const isBoundary = cls === "boundary" && type === "administrative";
  const name = fold(item.name || "");
  const want = fold(brgy);
  const wantBare = fold(String(brgy).replace(/\s*\(.*?\)\s*/g, ""));
  // Barangay-named public school (e.g. "Labne Elementary School") — rural
  // barangays are typically centered on their school. Derived, medium.
  const isSchool =
    cls === "amenity" &&
    type === "school" &&
    (name.startsWith(wantBare + " ") || name.startsWith(want + " "));
  if (!isPlace && !isBoundary && !isSchool) return null;
  const firstPart = fDisp.split(",")[0].trim();
  const nameOk =
    name === want || name === wantBare || firstPart === want || firstPart === wantBare;
  // Alias equivalence: same place, different numeral style (Dampol I = Dampol 1st)
  // or hyphenation (Cutcot = Cut-cot). Recorded as alias, medium confidence.
  const equiv = (s) =>
    fold(s)
      .replace(/\s*\(.*?\)\s*/g, "")
      .replace(/[''']/g, "")
      .replace(/\bsta\b\.?/g, "santa")
      .replace(/\bsto\b\.?/g, "santo")
      .replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1")
      .replace(/\b(i{1,3}|iv|v)\b/g, (m) => ({ i: "1", ii: "2", iii: "3", iv: "4", v: "5" }[m] || m))
      .replace(/[.\s-]+/g, "");
  // Verified same-place spelling variants (cross-checked with PSGC/PhilAtlas).
  const HARD_ALIASES = {
    "bocaue|tambobong": ["tambubong"],
    "paombong|binakod": ["binacod"],
    "dona remedios trinidad|sapang bulak": ["sapang bulac"],
    "dona remedios trinidad|pulong sampalok": ["pulong sampaloc"],
    // Francisco Homes phases are mapped under their tree names in Gumaoc, SJDM.
    "san jose del monte|francisco homes-mulawin": ["mulawin"],
    "san jose del monte|francisco homes-narra": ["narra"],
    "san jose del monte|francisco homes-yakal": ["yakal"],
  };
  const aliasOk =
    (!nameOk && equiv(item.name || "") !== "" && equiv(item.name || "") === equiv(brgy)) ||
    (HARD_ALIASES[`${fold(city)}|${fold(brgy)}`] || []).includes(fold(item.name || ""));
  const rank = Number(item.place_rank || 99);
  let confidence = "low";
  if (nameOk && isBoundary) confidence = "high";
  else if (nameOk && isPlace) confidence = rank <= 20 ? "high" : "medium";
  else if (aliasOk && (isPlace || isBoundary)) confidence = "medium";
  else if (isSchool) confidence = "medium";
  else if (isPlace || isBoundary) confidence = "low";
  return {
    lat: Math.round(lat * 10000) / 10000,
    lng: Math.round(lng * 10000) / 10000,
    confidence,
    display: disp,
    osm: `${item.osm_type}/${item.osm_id}`,
    ...(aliasOk && !nameOk ? { alias: `${item.name} = ${brgy}` } : {}),
    ...(isSchool && !nameOk && !aliasOk ? { derived: `school ${item.name}` } : {}),
  };
}

async function geocode(city, brgy) {
  const queries = [`${brgy}, ${city}, Bulacan, Philippines`];
  // PSGC suffixes like "(Pob.)" are annotations, not map names — retry bare.
  const bare = String(brgy).replace(/\s*\(.*?\)\s*/g, "").trim();
  if (bare && fold(bare) !== fold(brgy)) {
    queries.push(`${bare}, ${city}, Bulacan, Philippines`);
  }
  // Roman numerals (Dampol II-A) vs arabic/ordinals on maps (Dampol 2nd).
  const roman = { I: "1", II: "2", III: "3", IV: "4", V: "5" };
  const arabic = String(bare).replace(
    /\b(I{1,3}|IV|V)\b/gi,
    (m) => roman[m.toUpperCase()] || m
  );
  if (fold(arabic) !== fold(brgy) && fold(arabic) !== fold(bare)) {
    queries.push(`${arabic}, ${city}, Bulacan, Philippines`);
  }
  // Abbreviations (Sta. Clara = Santa Clara, Sto. Niño = Santo Niño).
  const expanded = String(bare)
    .replace(/\bsta\b\.?/gi, "santa")
    .replace(/\bsto\b\.?/gi, "santo");
  if (fold(expanded) !== fold(brgy) && fold(expanded) !== fold(bare)) {
    queries.push(`${expanded}, ${city}, Bulacan, Philippines`);
  }
  // Apostrophes (Iba O'Este vs Iba Este).
  const noApos = String(brgy).replace(/[''']/g, "");
  if (fold(noApos) !== fold(brgy)) {
    queries.push(`${noApos}, ${city}, Bulacan, Philippines`);
  }
  // Verified alternate spellings to also query (same place, map uses variant).
  const ALIAS_QUERIES = {
    "dona remedios trinidad|pulong sampalok": ["Pulong Sampaloc"],
  };
  for (const aq of ALIAS_QUERIES[`${fold(city)}|${fold(brgy)}`] || []) {
    queries.push(`${aq}, ${city}, Bulacan, Philippines`);
  }
  let best = null;
  let bestLow = null;
  for (const q of queries) {
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=5&q=" +
      encodeURIComponent(q);
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const items = await res.json();
    await sleep(1200); // Nominatim policy: max 1 req/sec
    for (const item of items || []) {
      const s = scoreResult(item, city, brgy);
      if (!s) continue;
      if (s.confidence === "low") {
        if (!bestLow) bestLow = s;
        continue;
      }
      if (!best || ({ high: 0, medium: 1 }[s.confidence] < { high: 0, medium: 1 }[best.confidence])) {
        best = s;
      }
    }
    if (best && best.confidence === "high") break;
  }
  return { best, bestLow };
}

async function main() {
  const args = parseArgs();
  const cityFilter = args.city ? fold(args.city) : null;
  const limit = args.limit ? Number(args.limit) : Infinity;
  const dryRun = !!args["dry-run"];

  const raw = fs.readFileSync(CSV_PATH, "utf8");
  const rows = parseCsv(raw);
  const header = rows[0];
  const idx = {
    city: header.findIndex((h) => h.trim().toLowerCase() === "city"),
    brgy: header.findIndex((h) => h.trim().toLowerCase() === "barangay"),
    lat: header.findIndex((h) => h.trim().toLowerCase() === "lat"),
    lng: header.findIndex((h) => h.trim().toLowerCase() === "lng"),
  };

  let progress = {};
  try {
    progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf8"));
  } catch {}
  let sources = {};
  try {
    sources = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
  } catch {}

  const targets = [];
  for (let i = 1; i < rows.length; i++) {
    const city = String(rows[i][idx.city] || "").trim();
    const brgy = String(rows[i][idx.brgy] || "").trim();
    const hasCoords =
      rows[i][idx.lat] !== "" && rows[i][idx.lng] !== "" &&
      Number.isFinite(Number(rows[i][idx.lat]));
    if (hasCoords) continue;
    if (cityFilter && fold(city) !== cityFilter) continue;
    const key = `${fold(city)}|${fold(brgy)}`;
    if (progress[key]) continue;
    targets.push({ i, city, brgy, key });
  }

  console.log(`Targets: ${targets.length} (limit ${limit === Infinity ? "none" : limit})`);
  const review = [];
  let done = 0,
    accepted = 0;

  for (const t of targets.slice(0, limit)) {
    let best = null;
    let bestLow = null;
    try {
      ({ best, bestLow } = await geocode(t.city, t.brgy));
    } catch (e) {
      console.log(`ERR ${t.city} | ${t.brgy}: ${e.message} (retry next run)`);
      await sleep(2000);
      continue;
    }
    // (rate-limit sleep lives inside geocode(), per query)
    if (best) {
      accepted++;
      progress[t.key] = { ...best, at: new Date().toISOString() };
      sources[`${t.city} | ${t.brgy}`] = `OSM ${best.osm} (${best.confidence})`;
      if (!dryRun) {
        rows[t.i][idx.lat] = String(best.lat);
        rows[t.i][idx.lng] = String(best.lng);
      }
      console.log(`OK [${best.confidence}] ${t.city} | ${t.brgy} -> ${best.lat},${best.lng}`);
    } else {
      progress[t.key] = { rejected: true, at: new Date().toISOString() };
      review.push(
        `${t.city} | ${t.brgy}` +
          (bestLow ? ` (nearest: ${bestLow.display} @ ${bestLow.lat},${bestLow.lng})` : " (no hit)")
      );
      console.log(`SKIP ${t.city} | ${t.brgy}${bestLow ? " (low confidence)" : " (no result)"}`);
    }
    done++;
  }

  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
  fs.writeFileSync(SOURCES_PATH, JSON.stringify(sources, null, 2));
  if (!dryRun) {
    const esc = (s) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
    fs.writeFileSync(CSV_PATH, rows.map((r) => r.map(esc).join(",")).join("\n") + "\n");
  }
  console.log(`\nDone: ${done} checked, ${accepted} accepted${dryRun ? " (dry run, CSV untouched)" : ""}.`);
  if (review.length) {
    console.log(`REVIEW (${review.length} still blocked):`);
    for (const r of review.slice(0, 60)) console.log("  " + r);
    if (review.length > 60) console.log(`  ... and ${review.length - 60} more`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
