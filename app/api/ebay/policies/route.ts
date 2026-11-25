import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { guardApiRequest } from "@/lib/api-guard";
import { listPolicies } from "@/lib/ebay/publish";

export const dynamic = "force-dynamic";

// Lists the account's business policies (shipping, payment, returns) and marks
// the one the app will use for each — the pinned one from EBAY_SHIPPING_POLICY /
// EBAY_PAYMENT_POLICY / EBAY_RETURN_POLICY, or the first if none is pinned.
export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let accessToken: string | null;
  try {
    accessToken = await accessTokenFromCookie(req.cookies.get(EBAY_COOKIE)?.value);
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
  if (!accessToken) {
    return NextResponse.json(
      { ok: false, error: "eBay isn't connected. Connect your account and try again." },
      { status: 401 }
    );
  }

  const { policies, error } = await listPolicies(accessToken);
  return NextResponse.json({ ok: !error, policies, error });
}
