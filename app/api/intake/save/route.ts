import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { isIsoDate, saveIntakeBatch, type IntakeItemInput } from "@/lib/intake";
import { intakeError } from "@/lib/intake-route";

export const maxDuration = 60;
const MAX_BATCH = 40;

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: { items?: IntakeItemInput[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) {
    return NextResponse.json({ ok: false, error: "Nothing to save." }, { status: 400 });
  }
  if (items.length > MAX_BATCH) {
    return NextResponse.json(
      { ok: false, error: `Save at most ${MAX_BATCH} items at a time.` },
      { status: 400 }
    );
  }
  for (const [i, it] of items.entries()) {
    const n = i + 1;
    if (!String(it?.idLine ?? "").trim())
      return NextResponse.json({ ok: false, error: `Item ${n} needs an ID line.` }, { status: 400 });
    if (!(typeof it.cost === "number" && it.cost >= 0 && it.cost < 100000))
      return NextResponse.json({ ok: false, error: `Item ${n} needs a cost.` }, { status: 400 });
    if (!isIsoDate(it.datePurchased))
      return NextResponse.json({ ok: false, error: `Item ${n} needs a purchase date.` }, { status: 400 });
  }

  try {
    const tempIds = await saveIntakeBatch(items);
    return NextResponse.json({ ok: true, tempIds });
  } catch (e) {
    return intakeError("intake/save", e);
  }
}
