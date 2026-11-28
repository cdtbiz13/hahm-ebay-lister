import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { REMOVE_REASONS, removeIntake, type RemoveReason } from "@/lib/intake";
import { intakeError } from "@/lib/intake-route";

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: { tempId?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }
  const tempId = String(body.tempId ?? "").trim();
  const reason = String(body.reason ?? "") as RemoveReason;
  if (!tempId || !REMOVE_REASONS.includes(reason)) {
    return NextResponse.json({ ok: false, error: "Pick a reason." }, { status: 400 });
  }
  try {
    await removeIntake(tempId, reason);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return intakeError("intake/remove", e);
  }
}
