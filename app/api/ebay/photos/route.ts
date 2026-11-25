import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { guardApiRequest } from "@/lib/api-guard";
import { photoUploadError, uploadPhoto } from "@/lib/ebay/publish";

// Uploads a few photos to eBay and returns their eBay-hosted URLs, in order.
// The client sends an item's photos here in small batches before listing, so
// no single request carries all 24 photos (Vercel caps request bodies ~4.5 MB).
export const maxDuration = 60;
const MAX_PER_REQUEST = 4;

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: { images?: { mediaType: string; data: string }[]; sku?: string; start?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }
  const images = (body.images || []).slice(0, MAX_PER_REQUEST);
  if (!images.length) {
    return NextResponse.json({ ok: false, error: "No photos sent." }, { status: 400 });
  }

  const accessToken = await accessTokenFromCookie(req.cookies.get(EBAY_COOKIE)?.value).catch(
    () => null
  );
  if (!accessToken) {
    return NextResponse.json(
      { ok: false, error: "eBay isn't connected. Connect your account and try again." },
      { status: 401 }
    );
  }

  const sku = String(body.sku || "item").replace(/\s+/g, "-");
  const start = Number(body.start) || 0;
  const urls = await Promise.all(
    images.map((img, i) => uploadPhoto(accessToken, img.data, img.mediaType, `${sku}-${start + i + 1}.jpg`))
  );
  if (urls.some((u) => !u)) {
    const why = photoUploadError();
    return NextResponse.json(
      { ok: false, error: `Could not upload a photo to eBay${why ? `: ${why}` : "."}` },
      { status: 502 }
    );
  }
  return NextResponse.json({ ok: true, urls });
}
