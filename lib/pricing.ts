// Every price this app suggests ends in .89 — it's the house price ending, so
// listings stay visually consistent whether they're shown in the UI, exported to
// CSV, or pushed to eBay. Snapping happens in one place (here) and is applied
// wherever a model-suggested price enters the system.

const PRICE_ENDING_CENTS = 89;

// Keep the dollar amount and set the cents to .89 — never drop to a lower
// dollar. e.g. 25.00 → 25.89, 25.20 → 25.89, 25.50 → 25.89, 0.10 → 0.89.
// The one case that moves down is cents already above .89 (25.99 → 25.89), a
// dime at most, and never across a dollar boundary.
export function roundTo89(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid price: ${value}`);
  }
  const dollars = Math.max(Math.floor(Math.round(value * 100) / 100), 0);
  return (dollars * 100 + PRICE_ENDING_CENTS) / 100;
}

// Parse a model- or user-supplied price and snap it to the .89 ending.
// Returns undefined for anything unusable so callers can apply their own default.
export function normalizePrice(
  value: number | string | undefined | null
): number | undefined {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (n === undefined || n === null || !Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return roundTo89(n);
}
