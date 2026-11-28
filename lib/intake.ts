// Sourcing intake: log newly bought items into the tracker, then link them to
// their eBay listing later.
//
// Two places in the tracker workbook:
//  • The year tab (TRACKER_TAB, default "2026"): the real inventory row.
//      A = ID (temp ID → SKU later)   B = description / title
//      D = size                       E = quantity (1)
//      G = date purchased             H = cost (incl. tax)
//      I = eBay price                 L = status (Active / Sold / Donate)
//    Columns C, F, J–X are never touched here except J/K on "Donated".
//  • A hidden "App Intake" tab: the app's own list of items awaiting photos,
//    including a small thumbnail so the item can be recognized at listing time.
//    The thumbnail is erased once the item is linked or removed.

import {
  a1,
  addHiddenTab,
  batchUpdateValues,
  getValues,
  listTabs,
  trackerTab,
} from "./google-sheets";

export const INTAKE_TAB = "App Intake";
const INTAKE_HEADER = [
  "Temp ID",
  "ID line",
  "Size",
  "Cost",
  "Date purchased",
  "Sold search",
  "Terapeak search",
  "Status",
  "Updated",
  "Thumbnail",
];
const TRACKER_FIRST_ROW = 5; // row 5 is the header; data starts below
const MAX_TRACKER_ROW = 4931;
// Google Sheets refuses cells over 50,000 characters.
export const MAX_THUMB_CHARS = 48_000;

// Column L only accepts the tracker's own statuses: Active, Sold, Donate.
// "Awaiting photos" lives in the App Intake list, not in the tracker.
export const STATUS_AWAITING = "Active";
export const STATUS_LISTED = "Active";
export const STATUS_DONATE = "Donate";
export const REMOVE_REASONS = ["Donated", "Damaged", "Keeping", "Other"] as const;
export type RemoveReason = (typeof REMOVE_REASONS)[number];

export interface IntakeItemInput {
  idLine: string;
  size?: string;
  cost: number;
  datePurchased: string; // YYYY-MM-DD
  soldSearch?: string;
  terapeakSearch?: string;
  thumb?: string; // data:image/jpeg;base64,...
}

export interface IntakeItem {
  tempId: string;
  idLine: string;
  size: string;
  cost: number;
  datePurchased: string;
  soldSearch: string;
  terapeakSearch: string;
  thumb: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function isIsoDate(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

function mmdd(iso: string): string {
  return iso.slice(5, 7) + iso.slice(8, 10);
}

function usDate(iso: string): string {
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
}

function todayCentralIso(): string {
  // en-CA formats as YYYY-MM-DD.
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

// Keep anything typed into a cell from being read as a formula.
function cellText(s: unknown, max = 200): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return /^[=+\-@]/.test(t) ? `'${t}` : t;
}

// Force plain text so Sheets doesn't turn "1127-01" or a size like "9/29"
// into a date. The leading apostrophe isn't shown or read back.
function asText(s: unknown, max = 80): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return t ? `'${t}` : "";
}

function parseMoney(s: string | undefined): number {
  const n = parseFloat(String(s ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function ensureIntakeTab(): Promise<void> {
  const tabs = await listTabs();
  if (!tabs.some((t) => t.title === INTAKE_TAB)) {
    await addHiddenTab(INTAKE_TAB, INTAKE_HEADER);
  }
}

async function trackerIds(): Promise<{ ids: string[]; lastUsedRow: number }> {
  const tab = trackerTab();
  const rows = await getValues(a1(tab, `A${TRACKER_FIRST_ROW + 1}:B${MAX_TRACKER_ROW}`));
  let lastUsedRow = TRACKER_FIRST_ROW;
  rows.forEach((r, i) => {
    if ((r[0] ?? "").trim() || (r[1] ?? "").trim()) lastUsedRow = TRACKER_FIRST_ROW + 1 + i;
  });
  return { ids: rows.map((r) => (r[0] ?? "").trim()), lastUsedRow };
}

async function intakeRows(): Promise<string[][]> {
  await ensureIntakeTab();
  return getValues(a1(INTAKE_TAB, "A2:J2000"));
}

/** Find the tracker row holding this ID (temp ID or SKU). */
async function findTrackerRow(id: string): Promise<number | null> {
  const want = id.trim().toLowerCase();
  if (!want) return null;
  const { ids } = await trackerIds();
  const idx = ids.findIndex((v) => v.toLowerCase() === want);
  return idx === -1 ? null : TRACKER_FIRST_ROW + 1 + idx;
}

// ── Save a batch ─────────────────────────────────────────────────────────────

/**
 * Give each item the next temp ID for its purchase date (MMDD-NN), write its
 * tracker row, and add it to the intake list. Returns the temp IDs in order.
 */
export async function saveIntakeBatch(items: IntakeItemInput[]): Promise<string[]> {
  const tab = trackerTab();
  const existingIntake = await intakeRows();
  const { ids: trackerIdList, lastUsedRow } = await trackerIds();

  // Highest NN already used per MMDD, across the tracker and the intake list
  // (so temp IDs never repeat, even after one is swapped for a SKU).
  const used = new Map<string, number>();
  for (const id of [...trackerIdList, ...existingIntake.map((r) => r[0] ?? "")]) {
    const m = /^(\d{4})-(\d{2,3})$/.exec(id.trim());
    if (m) used.set(m[1], Math.max(used.get(m[1]) ?? 0, parseInt(m[2], 10)));
  }

  const tempIds: string[] = [];
  const trackerWrites: { range: string; values: (string | number)[][] }[] = [];
  const intakeValues: (string | number)[][] = [];
  const stamp = new Date().toISOString();

  items.forEach((item, i) => {
    const key = mmdd(item.datePurchased);
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    const tempId = `${key}-${String(n).padStart(2, "0")}`;
    tempIds.push(tempId);

    const row = lastUsedRow + 1 + i;
    if (row > MAX_TRACKER_ROW) throw new Error("The tracker tab is full — add more rows to it first.");
    const cost = Math.round(item.cost * 100) / 100;
    trackerWrites.push(
      { range: a1(tab, `A${row}:B${row}`), values: [[asText(tempId), cellText(item.idLine)]] },
      { range: a1(tab, `D${row}:E${row}`), values: [[asText(item.size, 40), 1]] },
      { range: a1(tab, `G${row}:H${row}`), values: [[usDate(item.datePurchased), cost]] },
      { range: a1(tab, `L${row}`), values: [[STATUS_AWAITING]] }
    );
    intakeValues.push([
      asText(tempId),
      cellText(item.idLine),
      asText(item.size, 40),
      cost,
      asText(item.datePurchased),
      cellText(item.soldSearch ?? ""),
      cellText(item.terapeakSearch ?? ""),
      "awaiting",
      stamp,
      item.thumb && item.thumb.length <= MAX_THUMB_CHARS ? item.thumb : "",
    ]);
  });

  // Intake list first: if the tracker write then fails, the temp IDs are still
  // reserved and visible in the app rather than silently reused.
  const intakeStart = existingIntake.length + 2;
  await batchUpdateValues([
    {
      range: a1(INTAKE_TAB, `A${intakeStart}:J${intakeStart + intakeValues.length - 1}`),
      values: intakeValues,
    },
  ]);
  await batchUpdateValues(trackerWrites);
  return tempIds;
}

// ── List items awaiting photos ───────────────────────────────────────────────

export async function listAwaiting(): Promise<IntakeItem[]> {
  const rows = await intakeRows();
  return rows
    .filter((r) => (r[7] ?? "") === "awaiting" && (r[0] ?? "").trim())
    .map((r) => ({
      tempId: r[0].trim(),
      idLine: r[1] ?? "",
      size: r[2] ?? "",
      cost: parseMoney(r[3]),
      datePurchased: r[4] ?? "",
      soldSearch: r[5] ?? "",
      terapeakSearch: r[6] ?? "",
      thumb: r[9] ?? "",
    }))
    .reverse(); // newest first
}

async function closeIntakeRow(tempId: string, status: string): Promise<void> {
  const rows = await intakeRows();
  const idx = rows.findIndex((r) => (r[0] ?? "").trim() === tempId);
  if (idx === -1) return;
  const row = idx + 2;
  await batchUpdateValues([
    { range: a1(INTAKE_TAB, `H${row}:J${row}`), values: [[status, new Date().toISOString(), ""]] },
  ]);
}

// ── Link to a listing ────────────────────────────────────────────────────────

/**
 * Called when the item's eBay listing is scheduled: swap the temp ID for the
 * SKU in column A, fill the final title (B) and eBay price (I), mark Listed,
 * and drop the intake thumbnail.
 */
export async function linkIntake(
  tempId: string,
  update: { sku?: string; title?: string; price?: number }
): Promise<{ row: number }> {
  const tab = trackerTab();
  const sku = update.sku?.trim();
  // A retried link may find the row already renamed to the SKU.
  const row = (await findTrackerRow(tempId)) ?? (sku ? await findTrackerRow(sku) : null);
  if (!row) throw new Error(`Couldn't find ${tempId} in column A of the ${tab} tab.`);

  const writes: { range: string; values: (string | number)[][] }[] = [];
  writes.push({ range: a1(tab, `A${row}`), values: [[asText(sku || tempId, 50)]] });
  if (update.title?.trim()) {
    writes.push({ range: a1(tab, `B${row}`), values: [[cellText(update.title, 80)]] });
  }
  if (update.price && update.price > 0) {
    writes.push({ range: a1(tab, `I${row}`), values: [[Math.round(update.price * 100) / 100]] });
  }
  writes.push({ range: a1(tab, `L${row}`), values: [[STATUS_LISTED]] });
  await batchUpdateValues(writes);
  await closeIntakeRow(tempId, "linked");
  return { row };
}

// ── Remove (donated, damaged, keeping…) ──────────────────────────────────────

export async function removeIntake(tempId: string, reason: RemoveReason): Promise<void> {
  const tab = trackerTab();
  const row = await findTrackerRow(tempId);
  // Donated and Damaged are written off the tracker's way: status Donate,
  // "Amount Sold For (if donated put 0)" = 0, and today's date.
  // Keeping / Other only leave the app's list; the tracker row is untouched.
  if (row && (reason === "Donated" || reason === "Damaged")) {
    await batchUpdateValues([
      { range: a1(tab, `L${row}`), values: [[STATUS_DONATE]] },
      { range: a1(tab, `J${row}:K${row}`), values: [[0, usDate(todayCentralIso())]] },
    ]);
  }
  await closeIntakeRow(tempId, `removed: ${reason}`);
}
