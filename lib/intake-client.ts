// Shared browser-side pieces of the intake feature: tax sources, cost math,
// research links, and the types the screens pass around.

import { minimumPrice } from "./package";

export interface TaxSource {
  id: string;
  label: string;
  rate: number; // 0.07 = 7%
}

// Rates checked Nov 2026: Indiana is a flat 7% statewide. Marshall, IL is
// 6.25% state + 2% Clark County = 8.25% — confirm against a receipt and edit
// here if it differs.
export const TAX_SOURCES: TaxSource[] = [
  { id: "terre-haute", label: "Terre Haute store (7%)", rate: 0.07 },
  { id: "marshall", label: "Marshall store (8.25%)", rate: 0.0825 },
  { id: "none", label: "No tax (yard sale, FB, etc.)", rate: 0 },
];

export interface IntakeDraft {
  key: string;
  thumb: string; // small data URL, saved to the sheet
  status: "reading" | "ready" | "error";
  error?: string;
  idLine: string;
  size: string;
  soldSearch: string;
  terapeakSearch: string;
  shelfPrice: string; // what you typed (before tax unless "tax included")
  bundle?: { total: number; count: number };
  selected?: boolean;
}

export interface AwaitingItem {
  tempId: string;
  idLine: string;
  size: string;
  cost: number;
  datePurchased: string;
  soldSearch: string;
  terapeakSearch: string;
  thumb: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Cost that goes in the tracker: shelf price plus tax, unless tax is already in it. */
export function costWithTax(shelf: number, rate: number, taxIncluded: boolean): number {
  if (!Number.isFinite(shelf) || shelf < 0) return NaN;
  return round2(taxIncluded ? shelf : shelf * (1 + rate));
}

export function floorFor(cost: number): number {
  return cost > 0 ? round2(minimumPrice(cost)) : NaN;
}

// ── Buy / pass verdict for the sourcing check ───────────────────────────────
// eBay fees match the minimum-price formula: 13.6% FVF + 3% promoted = 16.6%,
// plus the $0.40 order fee. Shipping isn't included.
const EBAY_KEEP = 0.834;
const ORDER_FEE = 0.4;
const REINVEST = 0.43;
// Friday split: cost back first, then profit → 55% payout / 25% taxes /
// 15% extra reinvest / 5% buffer. "Your pay" is the 55%.
export const PAYOUT_SHARE = 0.55;

export type Verdict = "good" | "thin" | "pass";

// Boss sends 10% offers and runs 10% sales, sometimes both at once.
// Pass if one 10% discount would drop the sale under the minimum price.
export const ONE_DISCOUNT = 0.9;

export interface BuyCheck {
  cost: number; // what you'd pay, incl. tax
  floor: number; // minimum sale price for that cost
  passLine: number; // list price where a 10% discount still clears the minimum
  multiple: number; // list price ÷ cost
  profit: number; // after eBay fees, before shipping — the whole 100% before the split
  pay: number; // your 55% of that profit
  maxShelf: number; // most to pay at the register (before tax) for this list price
  verdict: Verdict;
}

export function checkBuy(
  listPrice: number,
  shelf: number,
  rate: number,
  taxIncluded: boolean,
  multiplier: number
): BuyCheck | null {
  const cost = costWithTax(shelf, rate, taxIncluded);
  if (!(listPrice > 0) || !Number.isFinite(cost)) return null;
  const floor = cost > 0 ? minimumPrice(cost) : 0;
  const multiple = cost > 0 ? listPrice / cost : Infinity;
  const profit = round2(listPrice * EBAY_KEEP - ORDER_FEE - cost);
  // Highest cost that still passes both rules, converted back to a shelf price.
  const maxCost = Math.max(
    0,
    Math.min((listPrice * ONE_DISCOUNT * EBAY_KEEP - ORDER_FEE) * REINVEST, listPrice / multiplier)
  );
  const maxShelf = Math.floor((taxIncluded ? maxCost : maxCost / (1 + rate)) * 100) / 100;
  const pay = round2(Math.max(0, profit) * PAYOUT_SHARE);
  // Pass: a 10% offer or sale would sell it under the minimum.
  // Thin: one discount is safe, but under the × rule (offer + sale stacked
  //       could dip under the minimum) — a warning, your call.
  // Good: at or above the × rule (3.5× ≈ safe even when both stack).
  const passLine = floor / ONE_DISCOUNT;
  const verdict: Verdict = listPrice < passLine ? "pass" : multiple < multiplier ? "thin" : "good";
  return { cost, floor: round2(floor), passLine: round2(passLine), multiple, profit, pay, maxShelf, verdict };
}

const MULT_KEY = "sourcing:multiplier:v1";
export function loadMultiplier(): number {
  try {
    const n = parseFloat(window.localStorage.getItem(MULT_KEY) ?? "");
    return n >= 1 && n <= 20 ? n : 3.5;
  } catch {
    return 3.5;
  }
}
export function storeMultiplier(n: number): void {
  try {
    window.localStorage.setItem(MULT_KEY, String(n));
  } catch {
    /* ignore */
  }
}

// Sourcing finds are almost always used, so the sold-comps link is filtered to
// Pre-owned (the tight string itself carries no condition word).
export function soldCompsUrl(q: string): string {
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&LH_ItemCondition=3000`;
}

export function terapeakUrl(q: string): string {
  return `https://www.ebay.com/sh/research?marketplace=EBAY-US&keywords=${encodeURIComponent(
    q
  )}&dayRange=90&tabName=SOLD`;
}

export function todayLocalIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── Light persistence so a reload doesn't lose an unsaved batch ─────────────
const BATCH_KEY = "intake:batch:v1";
const SETTINGS_KEY = "intake:settings:v1";

export function loadBatch(): IntakeDraft[] {
  try {
    const raw = window.localStorage.getItem(BATCH_KEY);
    const items = raw ? (JSON.parse(raw) as IntakeDraft[]) : [];
    // Anything still "reading" when the page closed will never finish.
    return items.map((d) =>
      d.status === "reading" ? { ...d, status: "error", error: "Didn't finish — type the ID line." } : d
    );
  } catch {
    return [];
  }
}

export function storeBatch(items: IntakeDraft[]): void {
  try {
    window.localStorage.setItem(BATCH_KEY, JSON.stringify(items));
  } catch {
    /* storage full or blocked — batch just won't survive a reload */
  }
}

export interface IntakeSettings {
  sourceId: string;
  taxIncluded: boolean;
}

export function loadSettings(): IntakeSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) return { sourceId: "terre-haute", taxIncluded: false, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { sourceId: "terre-haute", taxIncluded: false };
}

export function storeSettings(s: IntakeSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
