#!/usr/bin/env node
/**
 * Build src/data/geonames-cities.json from the GeoNames cities5000 + countryInfo dumps.
 *
 * Source: https://download.geonames.org/export/dump/
 *
 * Output schema:
 *   {
 *     version: "cities5000-YYYY-MM-DD",
 *     cities: { [geonameId: string]: [lat, lng] },
 *     byName: { [lowerNameCc: string]: [lat, lng] },
 *     gidToIso: { [countryGeonameId: string]: iso2 }
 *   }
 *
 * Run after downloading cities5000.txt + countryInfo.txt into a working directory:
 *   node scripts/build-geonames.mjs /tmp/geonames
 */
import fs from "node:fs";
import path from "node:path";

const workDir = process.argv[2] || "/tmp/geonames";
const citiesPath = path.join(workDir, "cities5000.txt");
const countryPath = path.join(workDir, "countryInfo.txt");

if (!fs.existsSync(citiesPath) || !fs.existsSync(countryPath)) {
  console.error(`Missing ${citiesPath} or ${countryPath}. Download via:`);
  console.error(`  curl -sL https://download.geonames.org/export/dump/cities5000.zip | bsdtar -xf - -C ${workDir}`);
  console.error(`  curl -sL https://download.geonames.org/export/dump/countryInfo.txt -o ${workDir}/countryInfo.txt`);
  process.exit(1);
}

// Country: geonameId → ISO2
const gidToIso = {};
for (const line of fs.readFileSync(countryPath, "utf8").split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const cols = line.split("\t");
  if (cols[16]) gidToIso[cols[16]] = cols[0];
}

// Cities. On name collision, keep the higher-population entry.
const cities = {};
const byName = {};
const nameMaxPop = {};

const lines = fs.readFileSync(citiesPath, "utf8").split("\n");
for (const line of lines) {
  if (!line) continue;
  const cols = line.split("\t");
  const id = cols[0], name = cols[1], ascii = cols[2], altCsv = cols[3];
  const lat = parseFloat(cols[4]), lng = parseFloat(cols[5]);
  const cc = cols[8];
  const pop = parseInt(cols[14] || "0", 10);
  if (!id || Number.isNaN(lat) || Number.isNaN(lng)) continue;
  // 3 decimals ≈ 110m precision. The map jitters ±1.5km, so 110m rounding
  // is lost in the noise — trading it for ~40% smaller JSON is a good deal.
  const latR = Math.round(lat * 1000) / 1000;
  const lngR = Math.round(lng * 1000) / 1000;
  cities[id] = [latR, lngR];
  const keys = new Set();
  // Alt-names (native scripts, transliterations) inflate the index ~7x while
  // only adding 2.3% coverage on this corpus — dropped deliberately.
  if (name) keys.add(name.toLowerCase() + "|" + cc);
  if (ascii) keys.add(ascii.toLowerCase() + "|" + cc);
  for (const k of keys) {
    if (!nameMaxPop[k] || pop > nameMaxPop[k]) {
      byName[k] = [latR, lngR];
      nameMaxPop[k] = pop;
    }
  }
}

const version = `cities5000-${new Date().toISOString().slice(0, 10)}`;
const payload = { version, cities, byName, gidToIso };
const out = path.resolve(process.cwd(), "packages/core/src/data/geonames-cities.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(payload));
const size = fs.statSync(out).size;
console.log(`Wrote ${out}`);
console.log(`  version=${version}`);
console.log(`  cities=${Object.keys(cities).length}`);
console.log(`  byName=${Object.keys(byName).length}`);
console.log(`  gidToIso=${Object.keys(gidToIso).length}`);
console.log(`  size=${(size / 1024 / 1024).toFixed(2)} MB`);
