/**
 * Deterministic taxonomy refinement — collapse v1 categories via explicit merge rules.
 * More reliable than LLM-based mapping for the final step.
 *
 * Usage: node test/refine-taxonomy-manual.mjs
 */
import * as fs from "fs";
import * as path from "path";

const HOME = process.env.HOME;
const VAULT_CACHE = path.join(HOME, "ObsidianBookmarks/.roost/embedding-cache.json");
const TAXONOMY_V1 = path.join(import.meta.dirname, "taxonomy.json");
const OUT_FILE = path.join(import.meta.dirname, "taxonomy-v2.json");
const LOG_FILE = path.join(import.meta.dirname, "taxonomy-merge-log.txt");

const cache = JSON.parse(fs.readFileSync(fs.existsSync(VAULT_CACHE) ? VAULT_CACHE : path.join(HOME, "Library/Application Support/roost-app/.embedding-cache-tiktok.json"), "utf8"));
const v1 = JSON.parse(fs.readFileSync(TAXONOMY_V1, "utf8"));
const v1Mapping = v1.mapping;

function normalize(c) { return (c || "").trim().replace(/\.+$/, "").toLowerCase(); }

// Count items per v1 canonical
const canonicalCounts = new Map();
for (const v of Object.values(cache)) {
  if (!v?.vec) continue;
  const raw = normalize(v.category);
  const canonical = v1Mapping[raw] || raw;
  if (canonical) canonicalCounts.set(canonical, (canonicalCounts.get(canonical) || 0) + 1);
}

// ── Merge rules: v1 canonical → master category ──
// Anything not listed here keeps its v1 canonical name.
const MERGES = {
  // Technology
  "Tech": "Technology", "Artificial Intelligence": "Technology", "Cybersecurity": "Technology",
  "Web Development": "Technology", "Web": "Technology", "Development": "Technology",
  "Digital": "Technology", "Apps": "Technology", "Data": "Technology",
  "Innovation": "Technology", "Gadgetry": "Technology", "Gadgets": "Technology",
  "Electronics": "Technology", "SEO": "Technology", "Accessibility": "Technology",

  // Art
  "Artist": "Art", "Painting": "Art", "Sculpture": "Art", "Graphics": "Art",
  "Graphic Design": "Art", "Artistry": "Art", "Fan Art": "Art", "Surrealism": "Art",
  "Abstract": "Art", "Visuals": "Art", "Visual Effects": "Art", "Still Life": "Art",

  // Photography
  "Portrait & Selfie": "Photography", "Portraits & Selfie": "Photography",
  "Photographs": "Photography", "Pictures": "Photography", "Image": "Photography",
  "Aesthetics": "Photography",

  // Fitness & Health
  "Exercise": "Fitness", "Gym": "Fitness", "Gymnastics": "Fitness", "Yoga": "Fitness",
  "Health": "Fitness & Health", "Mental Health": "Fitness & Health",
  "Healthcare": "Fitness & Health", "Medical": "Fitness & Health", "Nutrition": "Fitness & Health",

  // Food & Drink
  "Food": "Food & Drink", "Recipes": "Food & Drink", "Drinks": "Food & Drink",
  "Cuisine": "Food & Drink", "Dessert": "Food & Drink", "Baking": "Food & Drink",
  "Coffee": "Food & Drink", "Beverage": "Food & Drink", "Foodie": "Food & Drink",
  "Dining": "Food & Drink", "Bar": "Food & Drink", "Restaurant": "Food & Drink",

  // Home & Interior
  "Interior Design": "Home & Interior", "Decor": "Home & Interior", "Home": "Home & Interior",
  "Bathroom": "Home & Interior", "Lighting": "Home & Interior", "Household": "Home & Interior",
  "Domestic": "Home & Interior", "Renovation": "Home & Interior", "Home Improvement": "Home & Interior",
  "Laundry": "Home & Interior", "Kitchen": "Home & Interior", "Workspace": "Home & Interior",
  "Lofts": "Home & Interior", "Storage": "Home & Interior", "Cleaning": "Home & Interior",
  "House": "Home & Interior",

  // Music
  "Concert": "Music", "Performance": "Music", "Musician": "Music",
  "Audio": "Music", "Dance": "Music",

  // Self Improvement
  "Motivation": "Self Improvement", "Inspiration": "Self Improvement",
  "Personal Growth": "Self Improvement", "Self": "Self Improvement",
  "Self Care": "Self Improvement", "Self Discovery": "Self Improvement",
  "Self Reflection": "Self Improvement", "Mindset": "Self Improvement",
  "Mindfulness": "Self Improvement", "Productivity": "Self Improvement",
  "Kaizen": "Self Improvement", "Success": "Self Improvement",
  "Motivational": "Self Improvement", "Inspiring": "Self Improvement",

  // Business & Finance
  "Finance": "Business & Finance", "Economics": "Business & Finance",
  "Economy": "Business & Finance", "Marketing": "Business & Finance",
  "Advertising": "Business & Finance", "Branding": "Business & Finance",
  "Startup": "Business & Finance", "Entrepreneurship": "Business & Finance",
  "Trading": "Business & Finance", "Market": "Business & Finance",

  // Crypto & Web3
  "Blockchain": "Crypto & Web3", "Cryptocurrency": "Crypto & Web3",

  // Career & Jobs
  "Job": "Career & Jobs", "Jobs": "Career & Jobs", "Career": "Career & Jobs",
  "Career Advice": "Career & Jobs", "Employment": "Career & Jobs",
  "Interview": "Career & Jobs", "Recruitment": "Career & Jobs",

  // News & Politics
  "News": "News & Politics", "Politics": "News & Politics", "Article": "News & Politics",
  "Journalism": "News & Politics", "Elections": "News & Politics",
  "Government": "News & Politics", "Politicians": "News & Politics",
  "Protest": "News & Politics", "Activism": "News & Politics",
  "Social Issues": "News & Politics", "Social Justice": "News & Politics",

  // Gaming
  "Game": "Gaming", "Games": "Gaming", "Gameplay": "Gaming",
  "Game Development": "Gaming", "Gamedev": "Gaming",

  // Nature & Outdoors
  "Nature": "Nature & Outdoors", "Landscape": "Nature & Outdoors",
  "Landscapes": "Nature & Outdoors", "Wildlife": "Nature & Outdoors",
  "Gardening": "Nature & Outdoors", "Botany": "Nature & Outdoors",
  "Hiking": "Nature & Outdoors", "Camping": "Nature & Outdoors",
  "Environment": "Nature & Outdoors", "Environmental": "Nature & Outdoors",
  "Climate": "Nature & Outdoors", "Sustainability": "Nature & Outdoors",
  "Marine": "Nature & Outdoors", "Florals": "Nature & Outdoors",

  // Travel
  "Places": "Travel", "Tourism": "Travel", "Vacation": "Travel",
  "Destination": "Travel", "Hotels": "Travel", "Travelers": "Travel",

  // Animals
  "Animal": "Animals", "Pet": "Animals", "Felines": "Animals",
  "Canines": "Animals",

  // Entertainment
  "Entertainment": "Entertainment", "Humor": "Entertainment", "Memes": "Entertainment",
  "Meme": "Entertainment", "Satire": "Entertainment", "Comedy": "Entertainment",
  "Nostalgia": "Entertainment", "Celebrity": "Entertainment", "Gossip": "Entertainment",
  "Film": "Entertainment", "Movies": "Entertainment", "Television": "Entertainment",
  "Documentary": "Entertainment", "Horror": "Entertainment",

  // Social Media
  "Social Media": "Social Media", "Social": "Social Media",
  "Blogging": "Social Media", "Vlogging": "Social Media", "Vlogs": "Social Media",
  "Influencers": "Social Media",

  // Education
  "Education": "Education", "Tutorial": "Education", "Instructional": "Education",
  "Study": "Education", "Academia": "Education", "Lectures": "Education",
  "Research": "Education", "How To": "Education",

  // Vehicles
  "Cars": "Vehicles", "Car": "Vehicles", "Vehicle": "Vehicles",
  "Motorcycle": "Vehicles", "Automotive": "Vehicles", "Transportation": "Vehicles",
  "Aviation": "Vehicles",

  // Anime & Animation
  "Anime": "Anime & Animation", "Anime/Manga": "Anime & Animation",
  "Animation": "Anime & Animation", "Cartoon": "Anime & Animation",
  "Fantasy": "Anime & Animation",

  // Relationships
  "Relationships": "Relationships", "Dating": "Relationships",
  "Family": "Relationships", "Parenting": "Relationships",
  "Friendship": "Relationships", "Romance": "Relationships",

  // DIY & Crafts
  "DIY": "DIY & Crafts", "Craft": "DIY & Crafts", "Crafts": "DIY & Crafts",
  "Woodworking": "DIY & Crafts", "Pottery": "DIY & Crafts",
  "Jewelry": "DIY & Crafts", "Collectibles": "DIY & Crafts",

  // Books & Literature
  "Book": "Books & Literature", "Book Review": "Books & Literature",
  "Book Recommendations": "Books & Literature", "Literature": "Books & Literature",
  "Reading": "Books & Literature", "Poetry": "Books & Literature",
  "Fiction": "Books & Literature", "Writing": "Books & Literature",

  // Real Estate
  "Real Estate": "Real Estate", "Real": "Real Estate", "Rental": "Real Estate",
  "Housing": "Real Estate",

  // Architecture
  "Architecture": "Architecture", "Building": "Architecture",
  "Construction": "Architecture", "Urban Planning": "Architecture",

  // Sports
  "Sports": "Sports", "Sport": "Sports", "Recreation": "Sports",

  // Conspiracy & Misinformation
  "Conspiracy": "Conspiracy", "Misinformation": "Conspiracy", "Scam": "Conspiracy",

  // Philosophy & Spirituality
  "Philosophy": "Philosophy", "Spirituality": "Philosophy",
  "Religion": "Philosophy", "Psychology": "Philosophy",

  // Science
  "Science": "Science", "Physics": "Science", "Biology": "Science",
  "Neuroscience": "Science", "Geology": "Science", "Space": "Science",
  "Space Exploration": "Science", "Astronomy": "Science", "Math": "Science",
  "Mathematics": "Science",

  // Events
  "Event": "Events", "Events": "Events", "Festivals": "Events",
  "Conferences": "Events", "Celebrations": "Events", "Weddings": "Events",
  "Conventions": "Events", "Meetings": "Events",

  // Misc catch-alls — merge small vague categories
  "Information": "Misc", "Discussion": "Misc", "Personal": "Misc",
  "Scene": "Misc", "Opinion": "Misc", "Review": "Misc",
  "Recommendation": "Misc", "Analysis": "Misc", "Comparison": "Misc",
  "Criticism": "Misc", "Critique": "Misc", "Controversy": "Misc",
  "Observations": "Misc", "Quotes": "Misc", "Quote": "Misc",
  "Confessions": "Misc", "Reactions": "Misc", "Complaints": "Misc",
  "Hack": "Misc", "Trends": "Misc",
};

// ── Apply merges ──
const v2Mapping = new Map();
const mergeLog = [];

for (const [cat, count] of canonicalCounts) {
  const master = MERGES[cat] || cat;
  v2Mapping.set(cat, master);
  if (master !== cat) {
    mergeLog.push({ from: cat, to: master, count });
  }
}

// ── Build final raw → master ──
const finalMapping = {};
for (const [raw, v1Canonical] of Object.entries(v1Mapping)) {
  finalMapping[raw] = v2Mapping.get(v1Canonical) || v1Canonical;
}

// ── Compute master counts ──
const masterCounts = new Map();
for (const [cat, count] of canonicalCounts) {
  const master = v2Mapping.get(cat) || cat;
  masterCounts.set(master, (masterCounts.get(master) || 0) + count);
}
const masterSorted = [...masterCounts.entries()].sort((a, b) => b[1] - a[1]);

// ── Write merge log ──
mergeLog.sort((a, b) => a.to.localeCompare(b.to) || b.count - a.count);

const logLines = [
  `Taxonomy v2 Merge Log (deterministic rules)`,
  `Generated: ${new Date().toISOString()}`,
  ``,
  `${canonicalCounts.size} v1 categories → ${masterCounts.size} master categories`,
  `${mergeLog.length} categories merged, ${canonicalCounts.size - mergeLog.length} kept as-is`,
  ``,
  `Master categories by item count:`,
  ...masterSorted.map(([m, n]) => `  ${String(n).padStart(5)}  ${m}`),
  ``,
  `═══════════════════════════════════════════`,
  `DETAILED MERGE LOG (what collapsed into what)`,
  `═══════════════════════════════════════════`,
];

let currentMaster = null;
for (const entry of mergeLog) {
  if (entry.to !== currentMaster) {
    currentMaster = entry.to;
    logLines.push(`\n═══ ${currentMaster} (${masterCounts.get(currentMaster)} total) ═══`);
  }
  logLines.push(`  ${String(entry.count).padStart(5)}  ← ${entry.from}`);
}

fs.writeFileSync(LOG_FILE, logLines.join("\n"));
console.log(`Merge log: ${LOG_FILE}`);

// ── Save ──
const output = {
  mapping: finalMapping,
  masterCategories: masterSorted.map(([m]) => m),
  v2Mapping: Object.fromEntries(v2Mapping),
  stats: {
    v1_canonicals: canonicalCounts.size,
    master_count: masterCounts.size,
    merged: mergeLog.length,
  },
};
fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
console.log(`Taxonomy v2: ${OUT_FILE}`);

console.log(`\n${masterCounts.size} master categories:`);
for (const [m, n] of masterSorted) {
  console.log(`  ${String(n).padStart(5)}  ${m}`);
}
