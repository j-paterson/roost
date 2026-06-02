#!/usr/bin/env node
// Generates tests/fixtures/vault/. The committed fixture is SYNTHETIC — no real
// bookmarks, handles, or personal paths.  Regenerate at any time with:
//
//   node tests/fixtures/build-fixture-vault.mjs
//
// To import real bookmarks from a production vault (not committed):
//
//   node tests/fixtures/build-fixture-vault.mjs --from-vault
//   ROOST_FIXTURE_VAULT=/path/to/vault node tests/fixtures/build-fixture-vault.mjs --from-vault

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "vault");
const FROM_VAULT = process.argv.includes("--from-vault");

function write(rel, content) {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

function writeVaultScaffold() {
  write(".obsidian/community-plugins.json", JSON.stringify(["roost"]));
  write(".obsidian/plugins/roost/manifest.json", JSON.stringify({
    id: "roost", name: "Roost", version: "0.0.1",
    minAppVersion: "1.10.0", description: "Roost plugin under test",
    author: "test", main: "main.js",
  }));
  write(".obsidian/plugins/roost/main.js", "// replaced by wdio-obsidian-service from repo root");
  write(".obsidian/plugins/roost/styles.css", "");
  // Settings: a (fake) cloud LLM key so llmAvailable() is true and the pipeline
  // views/overlays are active under the gate (e2e has no real Ollama). No network
  // happens — the views render from the pre-written .roost/cache/*.json fixtures.
  write(".obsidian/plugins/roost/data.json", JSON.stringify({
    llmBackend: "cloud",
    anthropicApiKey: "e2e-fixture-key-not-real",
  }));
  write(".obsidian/bases/bookmarks.base.json", JSON.stringify({
    views: [{ type: "roost-bookmarks", name: "Gallery" }],
  }));
  write("Bookmarks/All Bookmarks.base", [
    "filters:",
    '  and:',
    '    - file.inFolder("Bookmarks")',
    '    - note.roost_id',
    "views:",
    "  - type: roost-bookmarks",
    "    name: Gallery",
    "",
  ].join("\n"));
  write("Bookmarks/e2e-sub/ea.md", fm(
    { roost_id: "e2e_ea", roost_category: "Home", platform: "web", title: "E2E Explorer Fixture A", ...homeFm(HOME[0]) },
    "Explorer E2E subfolder fixture A — styled reading nook.",
  ));
  write("Bookmarks/e2e-sub/eb.md", fm(
    { roost_id: "e2e_eb", roost_category: "Home", platform: "web", title: "E2E Explorer Fixture B", ...homeFm(HOME[1]) },
    "Explorer E2E subfolder fixture B — desk setup.",
  ));
  write("Bookmarks/Explorer.base", [
    "filters:",
    '  and:',
    '    - file.inFolder("Bookmarks")',
    "views:",
    "  - type: roost-explorer",
    "    name: Explorer",
    "",
  ].join("\n"));
}

function mergeFmIntoNote(notePath, extraFm) {
  const text = fs.readFileSync(notePath, "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---(\n[\s\S]*)$/);
  if (!match) return;
  const merged = { ...parseFmBlock(match[1]), ...extraFm };
  const body = match[2];
  const lines = ["---"];
  for (const [k, v] of Object.entries(merged)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") lines.push(`${k}: ${JSON.stringify(v)}`);
    else if (typeof v === "number" || typeof v === "boolean") lines.push(`${k}: ${v}`);
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", body.replace(/^\n/, ""));
  fs.writeFileSync(notePath, lines.join("\n"));
}

function parseFmBlock(block) {
  const fm = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const raw = m[2].trim();
    try { fm[key] = JSON.parse(raw); } catch { fm[key] = raw.replace(/^"|"$/g, ""); }
  }
  return fm;
}

function enrichImportedPipelineFields(categorized, caches) {
  const synthByCat = {
    Products: PRODUCTS.map(productFm),
    Workouts: WORKOUTS.map(workoutFm),
    Recipes: RECIPES.map(recipeFm),
  };
  const catStart = {
    Recipes: 0, Places: 5, Media: 10, Products: 15, Workouts: 20, Tutorials: 25, Home: 30,
  };
  for (const item of categorized) {
    const synthRows = synthByCat[item.category];
    if (synthRows) {
      const text = fs.readFileSync(item.notePath, "utf8");
      const fieldRe = {
        Recipes: /recipe_cuisine|recipe_dish/,
        Products: /product_name|product_brand/,
        Workouts: /workout_target_area|workout_name/,
      }[item.category];
      if (!fieldRe?.test(text)) {
        const slot = Number(item.id.replace("bm_", "")) - catStart[item.category];
        mergeFmIntoNote(item.notePath, synthRows[slot % 5]);
      }
    }
    if (item.category === "Places") {
      const slot = Number(item.id.replace("bm_", "")) - catStart.Places;
      const p = PLACES[slot % PLACES.length];
      const existing = parseFmBlock(fs.readFileSync(item.notePath, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "");
      mergeFmIntoNote(item.notePath, {
        place_lat: p.lat,
        place_lng: p.lng,
        place_name: existing.place_name || p.name,
        place_city: existing.place_city || p.city,
        place_country: existing.place_country || p.country,
      });
      caches["places-cache.json"][item.id] = cacheEntry("place", {
        name: p.name,
        city: p.city,
        country: p.country,
        placeType: p.placeType,
        description: p.description,
        vibes: p.vibes,
        bestFor: p.bestFor,
        tips: p.tips,
        address: p.address,
        lat: p.lat,
        lng: p.lng,
      });
    }
  }
}

function chipHintsFromNote(notePath, category) {
  const text = fs.readFileSync(notePath, "utf8");
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const lines = fmMatch[1];
  const get = (key) => {
    const m = lines.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return m[1].replace(/^"|"$/g, ""); }
  };
  switch (category) {
    case "Recipes": return get("recipe_cuisine") || get("roost_subcategory");
    case "Places": return get("place_city") || get("place_country");
    case "Media": return get("media_where") || get("roost_subcategory");
    case "Products": return get("product_where_to_buy") || get("product_brand");
    case "Workouts": return get("workout_target_area");
    case "Tutorials": return get("tutorial_skill_area") || get("roost_subcategory");
    case "Home": return get("home_style") || get("roost_subcategory");
    default: return get("title");
  }
}

function buildPipelineSnapshot(unsortedGroups, knownCollections) {
  const U_ITEMS = unsortedGroups.flatMap((g) => g.itemIds);
  const proposals = unsortedGroups.map((g) => ({
    suggestedName: g.name,
    altNames: [g.name],
    count: g.itemIds.length,
    itemIds: g.itemIds,
    samples: g.itemIds.map((id) => ({ id })),
    confidence: g.confidence ?? 0.85,
    source: "cluster",
    fromCollection: false,
  }));

  const splitChildren = unsortedGroups.length > 1
    ? unsortedGroups.map((g) => ({
      id: g.id,
      itemIds: g.itemIds,
      name: { suggestedName: g.name, altNames: [g.name], fromCollection: false },
      samples: g.itemIds.slice(0, 6).map((id) => ({ id })),
      cohesion: g.cohesion ?? 0.85,
      children: null,
    }))
    : null;

  const splitTree = {
    id: "root",
    itemIds: U_ITEMS,
    name: { suggestedName: "Unsorted", altNames: ["Unsorted"], fromCollection: false },
    samples: U_ITEMS.slice(0, 6).map((id) => ({ id })),
    cohesion: 0.5,
    children: splitChildren,
  };

  const SNAPSHOT_TS = new Date("2020-01-01T12:00:00Z").getTime();
  write(`.roost/pipeline-snapshot-${SNAPSHOT_TS}.json`, {
    ts: SNAPSHOT_TS,
    platform: "",
    userTopics: Object.keys(knownCollections),
    collections: knownCollections,
    matched: {},
    matchDetailMap: [],
    unsortedIds: U_ITEMS,
    result: {
      proposals,
      platform: "",
      noiseItemIds: [],
      collections: knownCollections,
      splitTree,
    },
    totalItems: 50,
    scoredItems: U_ITEMS.length,
    proposalCount: proposals.length,
  });
}

async function buildFromVault() {
  const { importFromVault } = await import("./import-from-vault.mjs");
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  writeVaultScaffold();

  const imported = importFromVault(undefined, {
    root: ROOT,
    bookmarksDir: path.join(ROOT, "Bookmarks"),
    perCategory: 5,
  });

  enrichImportedPipelineFields(imported.categorized, imported.caches);

  for (const [file, content] of Object.entries(imported.caches)) {
    write(`.roost/cache/${file}`, content);
  }

  const knownCollections = {};
  const chipHints = {};
  for (const cat of ["Recipes", "Places", "Media", "Products", "Workouts", "Tutorials", "Home"]) {
    const ids = imported.categorized.filter((c) => c.category === cat).map((c) => c.id);
    knownCollections[cat] = ids;
    const first = imported.categorized.find((c) => c.category === cat);
    if (first) chipHints[cat] = chipHintsFromNote(first.notePath, cat);
  }

  const unsortedGroups = [];
  const byName = new Map();
  for (const u of imported.unsorted) {
    if (!byName.has(u.groupName)) byName.set(u.groupName, []);
    byName.get(u.groupName).push(u.id);
  }
  let gi = 0;
  for (const [name, itemIds] of byName) {
    unsortedGroups.push({
      id: `unsorted-${gi++}`,
      name,
      itemIds,
      confidence: 0.86,
      cohesion: 0.84,
    });
  }

  buildPipelineSnapshot(unsortedGroups, knownCollections);

  fs.writeFileSync(
    path.join(__dirname, "vault-import-manifest.json"),
    JSON.stringify({
      ...imported.manifest,
      chipHints,
      unsortedGroups: unsortedGroups.map((g) => ({ name: g.name, itemIds: g.itemIds })),
    }, null, 2),
  );

  console.log("Wrote fixture vault (from production) to", ROOT);
  console.log(`  ${imported.categorized.length} categorized + ${imported.unsorted.length} unsorted`);
  console.log("  Assets under Bookmarks/_assets/");
  console.log("  Chip hints for e2e:", JSON.stringify(chipHints));
}

/** YAML frontmatter — skips null/undefined. */
function fm(obj, body = "") {
  const lines = ["---"];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}:`);
      for (const item of v) {
        if (typeof item === "object" && item !== null) {
          lines.push(`  - item: ${JSON.stringify(item.item ?? "")}`);
          if (item.qty != null) lines.push(`    qty: ${JSON.stringify(item.qty)}`);
        } else {
          lines.push(`  - ${JSON.stringify(String(item))}`);
        }
      }
    } else if (typeof v === "string") {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---", "", body);
  return lines.join("\n");
}

const BASE = { platform: "tiktok", synced_at: "2026-04-10" };

// ── Rich per-category fixtures (5 each) ─────────────────────────────────────

const RECIPES = [
  {
    title: "Cacio e Pepe in 15 Minutes",
    dish: "Cacio e Pepe", cuisine: "Italian",
    prepTime: "5 min", cookTime: "15 min", difficulty: "medium",
    link: "https://example.com/cacio-e-pepe",
    ingredients: [
      { item: "spaghetti", qty: "200g" },
      { item: "pecorino", qty: "100g" },
      { item: "black pepper", qty: "2 tsp" },
    ],
    steps: ["Boil pasta al dente.", "Toast pepper in pan.", "Toss with cheese and pasta water."],
    tags: ["recipe"],
  },
  {
    title: "Shakshuka for Brunch",
    dish: "Shakshuka", cuisine: "Middle Eastern",
    prepTime: "10 min", cookTime: "25 min", difficulty: "easy",
    link: "https://example.com/shakshuka",
    ingredients: [
      { item: "eggs", qty: "4" },
      { item: "crushed tomatoes", qty: "1 can" },
      { item: "feta", qty: "80g" },
    ],
    steps: ["Simmer spiced tomato sauce.", "Crack in eggs.", "Cover until set."],
  },
  {
    title: "Tonkotsu Ramen Broth",
    dish: "Tonkotsu Ramen", cuisine: "Japanese",
    prepTime: "30 min", cookTime: "4 hr", difficulty: "hard",
    link: "https://example.com/tonkotsu",
    ingredients: [
      { item: "pork bones", qty: "2 kg" },
      { item: "ramen noodles", qty: "400g" },
      { item: "miso tare", qty: "3 tbsp" },
    ],
    steps: ["Blanch bones.", "Simmer broth 12 hours.", "Season and assemble bowls."],
  },
  {
    title: "Brown Butter Chocolate Chip Cookies",
    dish: "Chocolate Chip Cookies", cuisine: "American",
    prepTime: "20 min", cookTime: "12 min", difficulty: "easy",
    link: "https://example.com/cookies",
    ingredients: [
      { item: "butter", qty: "170g" },
      { item: "flour", qty: "280g" },
      { item: "chocolate chips", qty: "200g" },
    ],
    steps: ["Brown the butter.", "Mix dough.", "Bake at 175°C."],
  },
  {
    title: "Weeknight Pad Thai",
    dish: "Pad Thai", cuisine: "Thai",
    prepTime: "15 min", cookTime: "10 min", difficulty: "medium",
    link: "https://example.com/pad-thai",
    ingredients: [
      { item: "rice noodles", qty: "250g" },
      { item: "tamarind", qty: "2 tbsp" },
      { item: "peanuts", qty: "50g" },
    ],
    steps: ["Soak noodles.", "Stir-fry protein and sauce.", "Finish with lime and peanuts."],
  },
];

const PLACES = [
  {
    title: "Trattoria Da Enzo al 29",
    name: "Trattoria Da Enzo", city: "Rome", country: "Italy",
    placeType: "restaurant", lat: 41.8897, lng: 12.4692,
    address: "Via dei Vascellari, 29, Rome",
    bestFor: "carbonara", description: "Classic Roman trattoria.",
    vibes: ["cozy", "local"], tips: ["Book ahead on weekends"],
  },
  {
    title: "Tsukiji Outer Market Morning",
    name: "Tsukiji Outer Market", city: "Tokyo", country: "Japan",
    placeType: "market", lat: 35.6654, lng: 139.7707,
    address: "4 Chome Tsukiji, Tokyo",
    bestFor: "sushi breakfast", description: "Famous fish market stalls.",
    vibes: ["bustling", "foodie"], tips: ["Arrive before 9am"],
  },
  {
    title: "Café de Flore",
    name: "Café de Flore", city: "Paris", country: "France",
    placeType: "cafe", lat: 48.8542, lng: 2.332,
    address: "172 Blvd Saint-Germain, Paris",
    bestFor: "people watching", description: "Iconic Left Bank café.",
    vibes: ["classic", "literary"], tips: ["Try the hot chocolate"],
  },
  {
    title: "Borough Market Lunch",
    name: "Borough Market", city: "London", country: "UK",
    placeType: "market", lat: 51.5054, lng: -0.0909,
    address: "8 Southwark St, London",
    bestFor: "street food", description: "Historic food market.",
    vibes: ["lively", "diverse"], tips: ["Thursday–Saturday busiest"],
  },
  {
    title: "La Boqueria",
    name: "La Boqueria", city: "Barcelona", country: "Spain",
    placeType: "market", lat: 41.3819, lng: 2.1716,
    address: "La Rambla, 91, Barcelona",
    bestFor: "jamón and fruit", description: "Vibrant public market.",
    vibes: ["colorful", "touristy"], tips: ["Walk the full aisle"],
  },
];

const MEDIA = [
  {
    title: "The Bear — Season 2",
    media_title: "The Bear", media_creator: "Christopher Storer",
    media_genre: "drama", media_rating: "9/10", media_where: "Hulu",
    media_description: "Chef drama in Chicago.", roost_subcategory: "tv",
  },
  {
    title: "BoJack Horseman",
    media_title: "BoJack Horseman", media_creator: "Raphael Bob-Waksberg",
    media_genre: "animation", media_rating: "8.8/10", media_where: "Netflix",
    media_description: "Animated Hollywood satire.", roost_subcategory: "series",
    platform: "web",
  },
  {
    title: "The Three-Body Problem",
    media_title: "The Three-Body Problem", media_creator: "Liu Cixin",
    media_genre: "sci-fi", media_rating: "8.5/10", media_where: "Kindle",
    media_description: "Hard sci-fi epic.", roost_subcategory: "books",
    platform: "web",
  },
  {
    title: "Better Off Alone",
    media_title: "Better Off Alone", media_creator: "Alice Deejay",
    media_genre: "electronic", media_rating: "7.5/10", media_where: "Spotify",
    media_description: "90s dance classic.", roost_subcategory: "Music",
    media_spotify_id: "6rqhFgbbKwnb9MLmUQDhG6",
    platform: "web",
  },
  {
    title: "Past Lives",
    media_title: "Past Lives", media_creator: "Celine Song",
    media_genre: "romance", media_rating: "8.9/10", media_where: "Apple TV",
    media_description: "Quiet reunion drama.", roost_subcategory: "film",
    platform: "web",
  },
];

const PRODUCTS = [
  { title: "Vitamix 5200", name: "Vitamix 5200", brand: "Vitamix", type: "blender", price: "$549", rating: "4.8/5", whereToBuy: "Amazon", description: "Workhorse kitchen blender." },
  { title: "Aeropress Go", name: "Aeropress Go", brand: "Aeropress", type: "coffee", price: "$39", rating: "4.7/5", whereToBuy: "REI", description: "Travel coffee press." },
  { title: "Kindle Paperwhite", name: "Kindle Paperwhite", brand: "Amazon", type: "ereader", price: "$149", rating: "4.6/5", whereToBuy: "Amazon", description: "Waterproof e-reader." },
  { title: "Sonos Era 100", name: "Sonos Era 100", brand: "Sonos", type: "speaker", price: "$249", rating: "4.5/5", whereToBuy: "Sonos", description: "Compact smart speaker." },
  { title: "Misen Chef's Knife", name: "Misen Chef's Knife", brand: "Misen", type: "kitchen", price: "$65", rating: "4.4/5", whereToBuy: "Misen", description: "Affordable 8-inch chef knife." },
];

const WORKOUTS = [
  { title: "Leg Day — Squat Focus", name: "Lower Body Strength", type: "strength", targetArea: "legs", difficulty: "medium", duration: "45 min", equipment: ["barbell", "rack"], notes: "Progressive overload on squats." },
  { title: "20-Minute HIIT", name: "Full Body HIIT", type: "cardio", targetArea: "full body", difficulty: "hard", duration: "20 min", equipment: ["mat"], notes: "No rest between rounds." },
  { title: "Mobility Flow", name: "Hip Mobility", type: "mobility", targetArea: "hips", difficulty: "easy", duration: "15 min", equipment: ["band"], notes: "Great post-run." },
  { title: "Push Pull Superset", name: "Upper Push/Pull", type: "strength", targetArea: "upper body", difficulty: "medium", duration: "50 min", equipment: ["dumbbells"], notes: "Superset antagonists." },
  { title: "Zone 2 Bike", name: "Endurance Ride", type: "cardio", targetArea: "legs", difficulty: "easy", duration: "40 min", equipment: ["bike"], notes: "Keep HR in zone 2." },
];

const TUTORIALS = [
  { title: "Pour-Over for Beginners", topic: "Pour-over coffee", skillArea: "coffee", difficulty: "easy", timeEstimate: "8 min", tools: ["kettle", "dripper", "scale"], steps: ["Heat water to 96°C.", "Bloom grounds.", "Pulse pour to 300g."], description: "Classic V60 technique." },
  { title: "Git Rebase Workflow", topic: "Interactive rebase", skillArea: "git", difficulty: "medium", timeEstimate: "12 min", tools: ["terminal"], steps: ["git rebase -i main", "Reorder commits", "Force-push branch"], description: "Clean up PR history." },
  { title: "Knife Sharpening", topic: "Whetstone sharpening", skillArea: "kitchen", difficulty: "medium", timeEstimate: "15 min", tools: ["1000/6000 stone"], steps: ["Soak stone.", "Find angle.", "Polish edge."], description: "Restore a dull chef knife." },
  { title: "Obsidian Dataview Basics", topic: "Dataview queries", skillArea: "obsidian", difficulty: "easy", timeEstimate: "10 min", tools: ["Obsidian"], steps: ["Install plugin.", "Write LIST query.", "Add filters."], description: "Query vault metadata." },
  { title: "Sourdough Stretch & Fold", topic: "Sourdough shaping", skillArea: "baking", difficulty: "hard", timeEstimate: "20 min", tools: ["bench scraper"], steps: ["Wet hands.", "Stretch north.", "Fold and rotate."], description: "Build dough strength." },
];

const HOME = [
  { title: "Reading Nook", idea: "Reading corner", room: "living-room", style: "mid-century", budget: "$800", description: "Warm lamp + armchair + shelf." },
  { title: "Minimal Desk Setup", idea: "Work-from-home desk", room: "office", style: "minimal", budget: "$1200", description: "Standing desk and cable management." },
  { title: "Guest Bedroom Refresh", idea: "Guest room", room: "bedroom", style: "scandinavian", budget: "$600", description: "Neutral linens and plants." },
  { title: "Kitchen Open Shelving", idea: "Open shelves", room: "kitchen", style: "industrial", budget: "$400", description: "Display ceramics and cookbooks." },
  { title: "Balcony Garden", idea: "Container garden", room: "outdoor", style: "bohemian", budget: "$250", description: "Herbs in planters." },
];

function recipeFm(r) {
  return {
    recipe_dish: r.dish,
    recipe_cuisine: r.cuisine,
    recipe_prep_time: r.prepTime,
    recipe_cook_time: r.cookTime,
    recipe_difficulty: r.difficulty,
    recipe_link: r.link,
    recipe_ingredients: r.ingredients,
    recipe_steps: r.steps,
    enrichment_v_recipe: 1,
    ...(r.tags ? { tags: r.tags } : {}),
  };
}

function placeFm(p) {
  return {
    place_name: p.name,
    place_city: p.city,
    place_country: p.country,
    place_type: p.placeType,
    place_address: p.address,
    place_best_for: p.bestFor,
    place_lat: p.lat,
    place_lng: p.lng,
    place_description: p.description,
    place_vibes: p.vibes,
    place_tips: p.tips,
    enrichment_v_place: 1,
  };
}

function mediaFm(m) {
  return {
    media_title: m.media_title,
    media_creator: m.media_creator,
    media_genre: m.media_genre,
    media_rating: m.media_rating,
    media_where: m.media_where,
    media_description: m.media_description,
    roost_subcategory: m.roost_subcategory,
    ...(m.media_spotify_id ? { media_spotify_id: m.media_spotify_id } : {}),
    enrichment_v_mediaExtraction: 1,
  };
}

function productFm(p) {
  return {
    product_name: p.name,
    product_brand: p.brand,
    product_type: p.type,
    product_price: p.price,
    product_rating: p.rating,
    product_where_to_buy: p.whereToBuy,
    product_description: p.description,
    enrichment_v_product: 1,
  };
}

function workoutFm(w) {
  return {
    workout_name: w.name,
    workout_type: w.type,
    workout_target_area: w.targetArea,
    workout_difficulty: w.difficulty,
    workout_duration: w.duration,
    workout_equipment: w.equipment,
    workout_notes: w.notes,
    enrichment_v_workout: 1,
  };
}

function tutorialFm(t) {
  return {
    tutorial_topic: t.topic,
    tutorial_skill_area: t.skillArea,
    tutorial_difficulty: t.difficulty,
    tutorial_time_estimate: t.timeEstimate,
    tutorial_description: t.description,
    tutorial_tools: t.tools,
    tutorial_steps: t.steps,
    enrichment_v_tutorial: 1,
  };
}

function homeFm(h) {
  return {
    home_title: h.idea,
    home_room: h.room,
    home_style: h.style,
    home_budget: h.budget,
    home_description: h.description,
    enrichment_v_home: 1,
  };
}

function cacheEntry(triage, extraction) {
  return { triage, extraction };
}

function buildSyntheticVault() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  writeVaultScaffold();

  const CATEGORY_ROWS = [
  ["Recipes", RECIPES, recipeFm],
  ["Places", PLACES, placeFm],
  ["Media", MEDIA, mediaFm],
  ["Products", PRODUCTS, productFm],
  ["Workouts", WORKOUTS, workoutFm],
  ["Tutorials", TUTORIALS, tutorialFm],
  ["Home", HOME, homeFm],
  ];

  let counter = 0;
  const caches = {
  "recipe-cache.json": {},
  "places-cache.json": {},
  "media-cache.json": {},
  "products-cache.json": {},
  "workouts-cache.json": {},
  "tutorials-cache.json": {},
  "home-cache.json": {},
  };

  for (const [cat, rows, toFm] of CATEGORY_ROWS) {
  for (let i = 0; i < rows.length; i++) {
    const id = `bm_${counter++}`;
    const row = rows[i];
    const platform = row.platform ?? BASE.platform;
    const body = `${row.title} — fixture bookmark in ${cat}.`;
    write(`Bookmarks/${id}.md`, fm({
      roost_id: id,
      roost_category: cat,
      title: row.title,
      ...BASE,
      platform,
      ...toFm(row),
    }, body));

    const cacheFile = {
      Recipes: "recipe-cache.json",
      Places: "places-cache.json",
      Media: "media-cache.json",
      Products: "products-cache.json",
      Workouts: "workouts-cache.json",
      Tutorials: "tutorials-cache.json",
      Home: "home-cache.json",
    }[cat];

    const extraction = { ...toFm(row) };
    delete extraction.enrichment_v_recipe;
    delete extraction.enrichment_v_place;
    delete extraction.enrichment_v_mediaExtraction;
    delete extraction.enrichment_v_product;
    delete extraction.enrichment_v_workout;
    delete extraction.enrichment_v_tutorial;
    delete extraction.enrichment_v_home;
    caches[cacheFile][id] = cacheEntry(cat.toLowerCase().replace(/s$/, ""), mapExtraction(cat, row));
    }
  }

  function mapExtraction(cat, row) {
  switch (cat) {
    case "Recipes":
      return {
        dish: row.dish, cuisine: row.cuisine,
        ingredients: row.ingredients, steps: row.steps,
        prepTime: row.prepTime, cookTime: row.cookTime, difficulty: row.difficulty,
        notes: "", recipeLink: row.link,
      };
    case "Places":
      return {
        name: row.name, city: row.city, country: row.country,
        placeType: row.placeType, description: row.description,
        vibes: row.vibes, bestFor: row.bestFor, tips: row.tips, address: row.address,
        lat: row.lat, lng: row.lng,
      };
    case "Media":
      return {
        title: row.media_title, mediaType: row.roost_subcategory,
        genre: row.media_genre, where: row.media_where, rating: row.media_rating,
        summary: row.media_description,
      };
    case "Products":
      return {
        name: row.name, brand: row.brand, price: row.price,
        whereToBuy: row.whereToBuy, category: row.type, summary: row.description,
      };
    case "Workouts":
      return {
        name: row.name, targetArea: row.targetArea, difficulty: row.difficulty,
        duration: row.duration, exercises: [], notes: row.notes,
      };
    case "Tutorials":
      return {
        skill: row.topic, skillArea: row.skillArea, difficulty: row.difficulty,
        timeEstimate: row.timeEstimate, tools: row.tools, steps: row.steps, tips: [],
      };
    case "Home":
      return {
        idea: row.idea, room: row.room, style: row.style,
        products: [], tips: [row.description],
      };
    default:
      return row;
    }
  }

  const UNSORTED_LABELS = [
  "Saved TikTok pasta hack",
  "Restaurant rec — need to try",
  "Home office cable management",
  "Podcast episode on habits",
  "Stretch routine from PT",
  "Gift idea for Mom",
  "Documentary recommendation",
  "Mechanical keyboard review",
  "Weekend hike near Marin",
  "Meal prep containers",
  "Indie game trailer",
  "Coffee subscription?",
  "Bookshelf styling inspo",
  "Yoga flow for travel",
  "Smart bulb comparison",
  ];

  for (let i = 0; i < 15; i++) {
  const id = `bm_u_${i}`;
  write(`Bookmarks/${id}.md`, fm({
    roost_id: id,
    platform: "tiktok",
    title: UNSORTED_LABELS[i],
    synced_at: "2026-04-10",
  }, `Unsorted: ${UNSORTED_LABELS[i]}`));
  }

  for (let i = 0; i < 3; i++) {
  const id = `bm_x_${i}`;
  const m = MEDIA[i];
  write(`Bookmarks/${id}.md`, fm({
    roost_id: id,
    roost_category: "Media",
    platform: "twitter",
    title: `X bookmark: ${m.media_title}`,
    synced_at: "2026-04-10",
    ...mediaFm(m),
  }, `Test X bookmark — ${m.media_title}.`));
  }

  for (const [file, content] of Object.entries(caches)) {
    write(`.roost/cache/${file}`, content);
  }

  const knownCollections = {
  Recipes: ["bm_0", "bm_1", "bm_2", "bm_3", "bm_4"],
  Places: ["bm_5", "bm_6", "bm_7", "bm_8", "bm_9"],
  Media: ["bm_10", "bm_11", "bm_12", "bm_13", "bm_14"],
  Products: ["bm_15", "bm_16", "bm_17", "bm_18", "bm_19"],
  Workouts: ["bm_20", "bm_21", "bm_22", "bm_23", "bm_24"],
  Tutorials: ["bm_25", "bm_26", "bm_27", "bm_28", "bm_29"],
    Home: ["bm_30", "bm_31", "bm_32", "bm_33", "bm_34"],
  };

  buildPipelineSnapshot([
    { id: "group-a", name: "Food saves", itemIds: Array.from({ length: 5 }, (_, i) => `bm_u_${i}`), confidence: 0.85 },
    { id: "group-b", name: "Fitness & gifts", itemIds: Array.from({ length: 5 }, (_, i) => `bm_u_${i + 5}`), confidence: 0.82 },
    { id: "group-c", name: "Media & gear", itemIds: Array.from({ length: 5 }, (_, i) => `bm_u_${i + 10}`), confidence: 0.88 },
  ], knownCollections);

  console.log("Wrote fixture vault (synthetic) to", ROOT);
  console.log("  35 categorized bookmarks with full pipeline frontmatter");
  console.log("  15 unsorted + 3 X bookmarks");
}

if (FROM_VAULT) {
  buildFromVault().catch((err) => { console.error(err); process.exit(1); });
} else {
  buildSyntheticVault();
}
