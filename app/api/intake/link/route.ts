import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { linkIntake } from "@/lib/intake";
import { intakeError } from "@/lib/intake-route";

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: { tempId?: string; sku?: string; title?: string; price?: number | string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }
  const tempId = String(body.tempId ?? "").trim();
  if (!tempId) return NextResponse.json({ ok: false, error: "Missing temp ID." }, { status: 400 });
  const price = typeof body.price === "string" ? parseFloat(body.price) : body.price;

  try {
    const { row } = await linkIntake(tempId, {
      sku: body.sku ? String(body.sku) : undefined,
      title: body.title ? String(body.title) : undefined,
      price: Number.isFinite(price) ? (price as number) : undefined,
    });
    return NextResponse.json({ ok: true, row });
  } catch (e) {
    return intakeError("intake/link", e);
  }
}
