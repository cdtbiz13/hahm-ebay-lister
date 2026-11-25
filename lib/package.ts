// Default package weight and box size, from the seller's table (Nov 2026):
//   Light  — tees, tanks, long sleeves, blouses, dresses, skirts, shorts,
//            leggings, hats, belts, scarves, kids' clothing: 1 lb, 10×8×3 in
//   Heavy  — jeans, pants, flannels, sweatshirts, hoodies, sweaters,
//            light jackets: 2 lb, 10×8×4 in
//   Custom — coats, shoes, boots, handbags, bundles, household items: the
//            seller weighs and measures them; scheduling is blocked until set.

import type { ListingResult, PackageGroup } from "./types";

export interface PackageSpec {
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
}

export const PACKAGE_PRESETS: Record<Exclude<PackageGroup, "custom">, PackageSpec> = {
  light: { weightOz: 16, lengthIn: 10, widthIn: 8, heightIn: 3 },
  heavy: { weightOz: 32, lengthIn: 10, widthIn: 8, heightIn: 4 },
};

export const PACKAGE_GROUP_LABELS: Record<PackageGroup, string> = {
  light: "Light · 1 lb · 10×8×3",
  heavy: "Heavy · 2 lb · 10×8×4",
  custom: "Weigh it myself",
};

const CUSTOM_RE =
  /\b(coat|parka|puffer|overcoat|peacoat|trench|leather jacket|shoes?|sneakers?|boots?|booties|heels?|sandals?|loafers?|clogs?|slippers?|handbag|purse|tote|backpack|bag|bundle|lot of|lot\b|pyrex|corning|bowl|dish|plate|mug|glass|tool|lamp|decor)\b/i;
const HEAVY_RE =
  /\b(jeans?|pants?|trousers?|chinos?|joggers?|overalls?|flannel|sweatshirt|hoodie|sweaters?|cardigan|pullover|fleece|light jacket|jacket|windbreaker|shacket|vest)\b/i;
const LIGHT_CATEGORIES = /^(womens_|mens_)?(top|dress|skirt|clothing|scarf|belt|hat)$/;

// Best guess at the group from the category and title. The seller can change it.
export function guessPackageGroup(listing: ListingResult): PackageGroup {
  const cat = String(listing.category || "");
  const text = `${listing.title || ""} ${listing.item_type || ""} ${cat}`;
  if (/shoes|handbag|coat/.test(cat) || CUSTOM_RE.test(text)) return "custom";
  if (/pants|jeans|sweater/.test(cat) || HEAVY_RE.test(text)) return "heavy";
  if (LIGHT_CATEGORIES.test(cat.replace(/^(womens|mens)_/, "")) || /^(womens|mens)_/.test(cat)) {
    return "light";
  }
  if (/\b(shirt|tee|t-shirt|tank|blouse|top|dress|skirt|shorts|leggings|hat|cap|belt|scarf|kids|toddler|youth)\b/i.test(text)) {
    return "light";
  }
  return "custom";
}

function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The package to send for a listing, or null when it still needs the seller's
// own weight and box size.
export function resolvePackage(listing: ListingResult): PackageSpec | null {
  const group = listing.package_group || guessPackageGroup(listing);
  if (group !== "custom") return PACKAGE_PRESETS[group];
  const spec = {
    weightOz: num(listing.package_weight_oz),
    lengthIn: num(listing.package_length_in),
    widthIn: num(listing.package_width_in),
    heightIn: num(listing.package_height_in),
  };
  return spec.weightOz && spec.lengthIn && spec.widthIn && spec.heightIn ? spec : null;
}

// The seller's minimum price: what it takes for the 43% reinvest share alone to
// cover the item's cost after eBay fees (13.6% + 3% promoted, $0.40 order fee).
export function minimumPrice(cost: number): number {
  return (cost / 0.43 + 0.4) / 0.834;
}
