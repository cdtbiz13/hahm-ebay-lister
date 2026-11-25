// Final pass over item specifics before listing, by the seller's tiers:
//   Tier 1 (eBay-required: Brand, Department, Size, Size Type, Color, Type,
//          Style, Inseam/Waist…) — always filled, using eBay's dropdown value.
//   Tier 2 (filterable extras: Material, Fit, Rise, Leg Style, Sleeve Length,
//          Neckline, Closure, Pattern, Fabric Wash, Vintage…) — kept only when
//          they match one of eBay's dropdown values.
//   Tier 3 (low value: Garment Care, Season, Theme, Features, Accents, Pocket
//          Type, Personalize, Handmade…) — removed unless eBay requires them.
// eBay's search filters are built from its dropdown values, so a custom value
// like "Dark Blue" can miss the Blue filter; a wrong value is worse than none.

import type { AspectMeta } from "./taxonomy";
import { matchAllowed } from "./aspects";
import type { ListingResult } from "@/lib/types";

// Always dropped unless eBay marks them required.
const TIER3 = new Set([
  "garment care",
  "season",
  "theme",
  "features",
  "accents",
  "pocket type",
  "personalize",
  "personalization instructions",
  "handmade",
  "california prop 65 warning",
  "unit quantity",
  "unit type",
  "fabric weight",
  "occasion",
  "character",
  "character family",
]);

// Typed from tags; eBay has no fixed list for these. Never snapped.
const FREE_TEXT_OK = new Set(["brand", "mpn", "model", "product line", "style code", "country of origin", "country/region of manufacture"]);

// Measurement specifics: only that measurement, as a number.
const MEASURES: Record<string, RegExp> = {
  inseam: /inseam/i,
  "waist size": /waist/i,
  rise: /rise/i,
  "chest size": /chest|pit/i,
  length: /length/i,
};
const OTHER_MEASURE_WORDS = /waist|inseam|rise|chest|pit to pit|length|hip|thigh|leg opening|shoulder/gi;

function isSize(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("size") && !n.includes("size type") && n !== "waist size";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Closest eBay dropdown value for a free-form value, or null.
// Exact (case-insensitive / plural) first, then the longest eBay value that
// appears as whole words inside it ("Dark Blue" → "Blue", "100% Cotton" →
// "Cotton", "Cotton Blend Denim" → "Cotton Blend").
export function snapToAllowed(value: string, allowed: string[]): string | null {
  const exact = matchAllowed(value, allowed);
  if (exact) return exact;
  const v = ` ${value.toLowerCase().replace(/[^a-z0-9%]+/g, " ")} `;
  let best: string | null = null;
  for (const a of allowed) {
    const words = a.toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();
    if (words.length < 3) continue;
    if (new RegExp(` ${escapeRe(words)}s? `).test(v) && (!best || a.length > best.length)) best = a;
  }
  return best;
}

// A measurement value → "<n> in" snapped to eBay's list, or null when the
// value is really a different measurement ("Waist (flat across): 18").
function snapMeasure(name: string, value: string, allowed: string[]): string | null {
  const own = MEASURES[name.toLowerCase()];
  const words = (value.match(OTHER_MEASURE_WORDS) || []).map((w) => w.toLowerCase());
  if (words.some((w) => !own.test(w))) return null;
  const m = value.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!allowed.length) return `${n} in`;
  return (
    allowed.find((a) => {
      const am = a.match(/(\d+(?:\.\d+)?)/);
      return am && Number(am[1]) === n;
    }) || null
  );
}

// The listing's own measurement for a measurement specific, e.g. "Inseam: 30
// in" in the measurements text → "30". Empty when it isn't there.
function measureFromListing(name: string, listing: ListingResult): string {
  const word = name.toLowerCase() === "waist size" ? "waist" : name.toLowerCase();
  const text = `${JSON.stringify(listing.measurements ?? "")} ${String(listing.description || "")}`;
  const m = text.match(new RegExp(`${escapeRe(word)}[^0-9\\n]{0,25}(\\d+(?:\\.\\d+)?)`, "i"));
  return m ? m[1] : "";
}

// True for measurement specifics (never given a guessed default).
export function isMeasureAspect(name: string): boolean {
  return Boolean(MEASURES[name.toLowerCase()]);
}

// Mutates `aspects`. Returns notes for anything the seller should check.
export function finalizeAspects(
  aspects: Record<string, string[]>,
  meta: AspectMeta[],
  listing: ListingResult
): string[] {
  const notes: string[] = [];
  const metaBy = new Map(meta.map((m) => [m.name.toLowerCase(), m]));

  for (const key of Object.keys(aspects)) {
    const lk = key.toLowerCase();
    const m = metaBy.get(lk);
    const required = Boolean(m?.required);
    const allowed = m?.values || [];

    if (TIER3.has(lk) && !required) {
      delete aspects[key];
      continue;
    }
    if (FREE_TEXT_OK.has(lk) || isSize(key)) continue;

    const out: string[] = [];
    for (const raw of aspects[key] || []) {
      const value = String(raw || "").trim();
      if (!value) continue;
      let v: string | null;
      if (MEASURES[lk]) {
        v = snapMeasure(lk, value, allowed);
        // Wrong measurement in this field — try the listing's own measurement.
        if (!v) {
          const own = measureFromListing(lk, listing);
          v = own ? snapMeasure(lk, own, allowed) : null;
        }
      }
      else if (allowed.length) v = snapToAllowed(value, allowed);
      else v = null; // optional extra with no eBay list — leave it out
      if (v && !out.includes(v)) out.push(v);
    }

    if (out.length) {
      aspects[key] = m?.mode === "SELECTION_ONLY" ? out.slice(0, 1) : out;
    } else if (required && !MEASURES[lk]) {
      // Keep eBay-required values even without a dropdown match, but flag them.
      notes.push(`Check "${key}": "${(aspects[key] || []).join(", ")}" isn't one of eBay's options.`);
    } else if (required) {
      // A required measurement we couldn't read — never guess it.
      notes.push(`"${key}" couldn't be read from the photos — add it in Seller Hub when you review.`);
      delete aspects[key];
    } else {
      delete aspects[key];
    }
  }
  return notes;
}
