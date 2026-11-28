// Business expenses and mileage, written into the tracker's existing tabs.
//
//  • Expenses → EXPENSE_TAB (default " Non-Inventory Expenses 2026" — note the
//    leading space in the real tab name). Writes A item, B type, C amount,
//    D date. E–G (year / month) are the sheet's own formulas.
//  • Mileage → MILES_TAB (default "2026 miles"). Writes A date, C description,
//    D purpose, I miles. Other columns are the sheet's own.
//  • Saved trips (one-tap mileage) → hidden "App Trips" tab.
//
// For a new year, set EXPENSE_TAB / MILES_TAB in Vercel to the new tab names.

import { a1, addHiddenTab, batchUpdateValues, getValues, listTabs } from "./google-sheets";

const FIRST_DATA_ROW = 6; // row 5 is the header row on both tabs
const EXPENSE_MAX_ROW = 5009;
const MILES_MAX_ROW = 6007;
const TRIPS_TAB = "App Trips";

export function expenseTab(): string {
  return process.env.EXPENSE_TAB || " Non-Inventory Expenses 2026";
}
export function milesTab(): string {
  return process.env.MILES_TAB?.trim() || "2026 miles";
}

const clean = (s: unknown, max = 120) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return /^[=+\-@]/.test(t) ? `'${t}` : t;
};
const usDate = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const money = (s: string | undefined) => {
  const n = parseFloat(String(s ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** Last row (1-based) with anything typed in the given columns, or the header row. */
function lastUsedRow(rows: string[][], firstRow: number, cols: number): number {
  let last = firstRow - 1;
  rows.forEach((r, i) => {
    if (r.slice(0, cols).some((c) => (c ?? "").trim())) last = firstRow + i;
  });
  return last;
}

// ── Expense types (the sheet's own dropdown list) ───────────────────────────
export async function expenseTypes(): Promise<string[]> {
  const rows = await getValues(a1("Expense Type", "B6:B35"));
  return rows.map((r) => (r[0] ?? "").trim()).filter(Boolean);
}

export interface ExpenseRow {
  item: string;
  type: string;
  amount: number;
  date: string; // as shown in the sheet
}

export async function recentExpenses(limit = 8): Promise<ExpenseRow[]> {
  const rows = await getValues(a1(expenseTab(), `A${FIRST_DATA_ROW}:D${EXPENSE_MAX_ROW}`));
  return rows
    .filter((r) => (r[0] ?? "").trim() || (r[2] ?? "").trim())
    .slice(-limit)
    .reverse()
    .map((r) => ({ item: r[0] ?? "", type: r[1] ?? "", amount: money(r[2]), date: r[3] ?? "" }));
}

export async function addExpense(e: {
  item: string;
  type: string;
  amount: number;
  date: string; // YYYY-MM-DD
}): Promise<number> {
  const tab = expenseTab();
  const types = await expenseTypes();
  if (e.type && !types.includes(e.type)) throw new Error(`"${e.type}" isn't in the Expense Type list.`);
  const rows = await getValues(a1(tab, `A${FIRST_DATA_ROW}:D${EXPENSE_MAX_ROW}`));
  const row = lastUsedRow(rows, FIRST_DATA_ROW, 4) + 1;
  if (row > EXPENSE_MAX_ROW) throw new Error("The expenses tab is full — add more rows to it first.");
  await batchUpdateValues([
    {
      range: a1(tab, `A${row}:D${row}`),
      values: [[clean(e.item), e.type, Math.round(e.amount * 100) / 100, usDate(e.date)]],
    },
  ]);
  return row;
}

// ── Mileage ─────────────────────────────────────────────────────────────────
export interface MilesRow {
  date: string;
  description: string;
  purpose: string;
  miles: number;
}

async function milesRows(): Promise<string[][]> {
  return getValues(a1(milesTab(), `A${FIRST_DATA_ROW}:I${MILES_MAX_ROW}`));
}

export async function recentMiles(limit = 8): Promise<MilesRow[]> {
  const rows = await milesRows();
  // Column I shows 0.0 on every empty row (a formula), so judge by A–H.
  return rows
    .filter((r) => r.slice(0, 8).some((c) => (c ?? "").trim()))
    .slice(-limit)
    .reverse()
    .map((r) => ({ date: r[0] ?? "", description: r[2] ?? "", purpose: r[3] ?? "", miles: money(r[8]) }));
}

export async function addMiles(m: {
  date: string;
  description: string;
  purpose: string;
  miles: number;
}): Promise<number> {
  const tab = milesTab();
  const row = lastUsedRow(await milesRows(), FIRST_DATA_ROW, 8) + 1;
  if (row > MILES_MAX_ROW) throw new Error("The mileage tab is full — add more rows to it first.");
  await batchUpdateValues([
    { range: a1(tab, `A${row}`), values: [[usDate(m.date)]] },
    { range: a1(tab, `C${row}:D${row}`), values: [[clean(m.description), clean(m.purpose, 40)]] },
    { range: a1(tab, `I${row}`), values: [[Math.round(m.miles * 10) / 10]] },
  ]);
  return row;
}

// ── Saved trips ─────────────────────────────────────────────────────────────
export interface Trip {
  name: string;
  miles: number;
  purpose: string;
}

async function ensureTripsTab(): Promise<void> {
  const tabs = await listTabs();
  if (!tabs.some((t) => t.title === TRIPS_TAB)) {
    await addHiddenTab(TRIPS_TAB, ["Trip", "Miles", "Purpose"]);
  }
}

async function tripRows(): Promise<string[][]> {
  await ensureTripsTab();
  return getValues(a1(TRIPS_TAB, "A2:C200"));
}

export async function listTrips(): Promise<Trip[]> {
  return (await tripRows())
    .filter((r) => (r[0] ?? "").trim())
    .map((r) => ({ name: r[0].trim(), miles: money(r[1]), purpose: r[2] ?? "" }));
}

/** Add or update a saved trip by name. */
export async function saveTrip(t: Trip): Promise<void> {
  const rows = await tripRows();
  const name = clean(t.name, 60);
  let idx = rows.findIndex((r) => (r[0] ?? "").trim().toLowerCase() === name.toLowerCase());
  if (idx === -1) {
    idx = rows.findIndex((r) => !(r[0] ?? "").trim());
    if (idx === -1) idx = rows.length;
  }
  const row = idx + 2;
  await batchUpdateValues([
    { range: a1(TRIPS_TAB, `A${row}:C${row}`), values: [[name, Math.round(t.miles * 10) / 10, clean(t.purpose, 40)]] },
  ]);
}

export async function deleteTrip(name: string): Promise<void> {
  const rows = await tripRows();
  const idx = rows.findIndex((r) => (r[0] ?? "").trim().toLowerCase() === name.trim().toLowerCase());
  if (idx === -1) return;
  const row = idx + 2;
  await batchUpdateValues([{ range: a1(TRIPS_TAB, `A${row}:C${row}`), values: [["", "", ""]] }]);
}
