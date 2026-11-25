import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { guardApiRequest } from "@/lib/api-guard";
import { fetchAccountSetup } from "@/lib/ebay/publish";
import { scheduleListing, type ScheduleInput } from "@/lib/ebay/schedule";

// Photo upload + taxonomy lookups + Verify/Add calls — give it room.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: ScheduleInput;
  try {
    body = (await req.json()) as ScheduleInput;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid request." }, { status: 400 });
  }
  if (!body.listing || !Array.isArray(body.images) || body.images.length === 0) {
    return NextResponse.json(
      { success: false, error: "Missing listing or photos." },
      { status: 400 }
    );
  }

  let accessToken: string | null;
  try {
    accessToken = await accessTokenFromCookie(req.cookies.get(EBAY_COOKIE)?.value);
  } catch (e) {
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 500 });
  }
  if (!accessToken) {
    return NextResponse.json(
      { success: false, error: "eBay isn't connected. Connect your account and try again." },
      { status: 401 }
    );
  }

  const sku = String(body.listing.custom_label || "");
  try {
    const setup = await fetchAccountSetup(accessToken);
    const result = await scheduleListing(accessToken, setup, body);
    // A rejected listing is a business outcome, not a server fault (see publish).
    return NextResponse.json(result, { status: result.success ? 200 : 422 });
  } catch (e) {
    console.error(`[ebay/schedule] unhandled error sku=${sku}:`, e);
    return NextResponse.json(
      { success: false, sku, error: (e as Error).message },
      { status: 500 }
    );
  }
}
