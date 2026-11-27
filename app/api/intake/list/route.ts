import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import { listAwaiting } from "@/lib/intake";
import { intakeError } from "@/lib/intake-route";

// POST (not GET) so it goes through the same access-code handshake as the rest.
export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;
  try {
    return NextResponse.json({ ok: true, items: await listAwaiting() });
  } catch (e) {
    return intakeError("intake/list", e);
  }
}
