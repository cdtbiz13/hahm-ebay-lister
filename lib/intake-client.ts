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

export function soldCompsUrl(q: string): string {
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1`;
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
