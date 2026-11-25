// Scheduled eBay listings through the Trading API (AddFixedPriceItem with
// ScheduleTime). Unlike Inventory API drafts, a scheduled listing shows up in
// Seller Hub → Listings → Scheduled, where the seller can review, edit,
// reschedule or delete it before it goes live, and once live it's an ordinary
// listing that Seller Hub and Flyp can edit.
//
// Flow: validate → upload photos → leaf category + item specifics + condition
// (shared with the Inventory flow) → VerifyAddFixedPriceItem (fee check, with
// recovery for missing specifics / rejected condition / non-leaf category) →
// AddFixedPriceItem.

import { createHash } from "crypto";
import { EBAY_TRADING } from "./config";
import { suggestLeafCategory, categoryAspects, acceptedConditionIds, type AspectMeta } from "./taxonomy";
import { canonicalizeAspectKeys } from "./aspects";
import { fillRecommendedAspects } from "./aspectFill";
import {
  addMissingAspects,
  buildAspects,
  conditionIdsForGrade,
  normalizeConditionInput,
  photoUploadError,
  reconcileAspects,
  resolveCategory,
  uploadPhotos,
  type AccountSetup,
} from "./publish";
import { resolvePackage } from "@/lib/package";
import type { ListingResult } from "@/lib/types";

export interface ScheduleInput {
  listing: ListingResult;
  images: { mediaType: string; data: string }[];
}

export interface ScheduleResult {
  success: boolean;
  sku: string;
  itemId?: string;
  scheduledFor?: string;
  listingFees?: number;
  feeBreakdown?: { name: string; amount: number }[];
  warnings?: string[];
  error?: string;
}

// eBay lets a listing be scheduled up to 3 weeks ahead.
const MAX_SCHEDULE_MS = 21 * 24 * 60 * 60 * 1000;
const MIN_SCHEDULE_MS = 15 * 60 * 1000;
const COMPAT_LEVEL = "1193";

// ── Small XML helpers (the Trading API is XML-only) ──────────────────────────

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cdata(v: string): string {
  return `<![CDATA[${v.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function decode(v: string): string {
  return v
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

interface TradingError {
  code: string;
  severity: string;
  message: string;
}

interface TradingResp {
  ack: string;
  text: string;
  errors: TradingError[];
  itemId: string;
  fees: { name: string; amount: number }[];
}

function parseTrading(text: string): TradingResp {
  const ack = (text.match(/<Ack>([^<]+)<\/Ack>/) || [])[1] || "";
  const errors: TradingError[] = [];
  for (const m of text.matchAll(/<Errors>([\s\S]*?)<\/Errors>/g)) {
    const block = m[1];
    const pick = (tag: string) =>
      decode((block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1] || "");
    errors.push({
      code: pick("ErrorCode"),
      severity: pick("SeverityCode"),
      message: pick("LongMessage") || pick("ShortMessage"),
    });
  }
  const itemId = (text.match(/<ItemID>(\d+)<\/ItemID>/) || [])[1] || "";
  const fees: { name: string; amount: number }[] = [];
  for (const m of text.matchAll(/<Fee>\s*<Name>([^<]+)<\/Name>\s*<Fee[^>]*>([\d.]+)<\/Fee>/g)) {
    fees.push({ name: m[1], amount: Number(m[2]) || 0 });
  }
  return { ack, text, errors, itemId, fees };
}

async function tradingCall(accessToken: string, callName: string, inner: string): Promise<TradingResp> {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
${inner}
</${callName}Request>`;
  const resp = await fetch(EBAY_TRADING, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml;charset=utf-8",
      "X-EBAY-API-SITEID": "0",
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-CALL-NAME": callName,
      "X-EBAY-API-IAF-TOKEN": accessToken,
    },
    body: xml,
  });
  return parseTrading(await resp.text());
}

function hardErrors(r: TradingResp): TradingError[] {
  return r.errors.filter((e) => e.severity !== "Warning");
}

function errorText(r: TradingResp): string {
  const errs = hardErrors(r);
  if (!errs.length) return `eBay returned ${r.ack || "no response"}.`;
  return errs.map((e) => `${e.message}${e.code ? ` (${e.code})` : ""}`).join(" · ");
}

// Total listing-time fees. ListingFee is eBay's own total when present.
function totalFees(fees: { name: string; amount: number }[]): number {
  const total = fees.find((f) => f.name === "ListingFee");
  if (total) return total.amount;
  return fees.reduce((sum, f) => sum + f.amount, 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toNumber(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// ── The scheduled-listing flow ───────────────────────────────────────────────

export async function scheduleListing(
  accessToken: string,
  setup: AccountSetup,
  input: ScheduleInput
): Promise<ScheduleResult> {
  const { listing } = input;
  const sku = String(listing.custom_label || "").trim().slice(0, 50);

  // 1. Seller-entered fields. These are never guessed.
  if (!sku) {
    return { success: false, sku, error: "Enter your SKU or temp ID before scheduling." };
  }
  const price = round2(toNumber(listing.list_price));
  if (!(price > 0)) {
    return { success: false, sku, error: "Enter your eBay price before scheduling." };
  }
  const pkg = resolvePackage(listing);
  if (!pkg) {
    return {
      success: false,
      sku,
      error: "This item needs its weight and box size. Weigh it, enter them, then schedule.",
    };
  }
  const startAt = new Date(String(listing.schedule_at || ""));
  const delta = startAt.getTime() - Date.now();
  if (!Number.isFinite(delta) || delta < MIN_SCHEDULE_MS || delta > MAX_SCHEDULE_MS) {
    return {
      success: false,
      sku,
      error: "Pick a go-live time at least 15 minutes from now and no more than 3 weeks out.",
    };
  }
  if (!setup.fulfillmentPolicyId || !setup.paymentPolicyId || !setup.returnPolicyId) {
    return {
      success: false,
      sku,
      error:
        "A business policy is missing, or a pinned one (EBAY_SHIPPING_POLICY / EBAY_PAYMENT_POLICY / EBAY_RETURN_POLICY) wasn't found. Check /api/ebay/policies.",
    };
  }

  // 2. Photos → eBay Picture Services.
  const photoUrls = await uploadPhotos(accessToken, input.images.slice(0, 12), sku.replace(/\s+/g, "-"));
  if (!photoUrls.length) {
    const why = photoUploadError();
    return { success: false, sku, error: `Could not upload any photos to eBay${why ? `: ${why}` : "."}` };
  }

  // 3. Category, specifics, condition — same logic as the Inventory flow.
  const catKey = String(listing.category || "other");
  const { categoryId: staticCat, fallbacks } = resolveCategory(listing);
  const leaf = await suggestLeafCategory(`${listing.category_hint || ""} ${listing.title || ""}`);
  let catId = leaf || staticCat;

  const aspects = buildAspects(listing, catKey);
  let accepted = new Set<number>();
  let meta: AspectMeta[] = [];
  try {
    const [m, conds] = await Promise.all([
      categoryAspects(catId),
      acceptedConditionIds(catId, accessToken),
    ]);
    meta = m;
    accepted = conds;
    if (meta.length) {
      canonicalizeAspectKeys(aspects, meta);
      reconcileAspects(aspects, meta, listing, catKey);
    }
  } catch {
    /* taxonomy unavailable — the Verify recovery below still runs */
  }
  if (meta.length) await fillRecommendedAspects(listing, aspects, meta, sku);

  const grade = normalizeConditionInput(listing.condition);
  const conditionIds = conditionIdsForGrade(grade, accepted, catKey);
  let condIdx = 0;
  let fbIdx = 0;

  // Same inputs → same UUID, so a retried request can't create a second
  // listing (eBay answers with the existing ItemID instead).
  const uuid = createHash("sha256")
    .update(`${sku}|${startAt.toISOString()}|${price}`)
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();

  const autoAccept = round2(price * 0.9);
  const minOffer = round2(price * 0.7);
  const postal = process.env.EBAY_LOCATION_POSTAL_CODE || "62441";
  const location = process.env.EBAY_LOCATION_NAME || "Marshall, IL";

  const itemXml = () => {
    const conditionId = conditionIds[condIdx];
    const specifics = Object.entries(aspects)
      .filter(([, vals]) => vals.length)
      .map(
        ([name, vals]) =>
          `<NameValueList><Name>${esc(name)}</Name>${vals
            .map((v) => `<Value>${esc(v)}</Value>`)
            .join("")}</NameValueList>`
      )
      .join("");
    const isNew = conditionId === 1000 || conditionId === 1500 || conditionId === 1750;
    return `<Item>
    <Title>${esc(String(listing.title || "Untitled").slice(0, 80))}</Title>
    <Description>${cdata(listing.description || "")}</Description>
    <PrimaryCategory><CategoryID>${esc(catId)}</CategoryID></PrimaryCategory>
    <StartPrice currencyID="USD">${price.toFixed(2)}</StartPrice>
    ${conditionId ? `<ConditionID>${conditionId}</ConditionID>` : ""}
    ${!isNew && listing.condition_notes ? `<ConditionDescription>${esc(String(listing.condition_notes).slice(0, 1000))}</ConditionDescription>` : ""}
    <Country>US</Country>
    <Currency>USD</Currency>
    <Location>${esc(location)}</Location>
    <PostalCode>${esc(postal)}</PostalCode>
    <ListingType>FixedPriceItem</ListingType>
    <ListingDuration>GTC</ListingDuration>
    <Quantity>1</Quantity>
    <SKU>${esc(sku)}</SKU>
    <UUID>${uuid}</UUID>
    <ScheduleTime>${startAt.toISOString()}</ScheduleTime>
    <PictureDetails>${photoUrls.map((u) => `<PictureURL>${esc(u)}</PictureURL>`).join("")}</PictureDetails>
    <ItemSpecifics>${specifics}</ItemSpecifics>
    <SellerProfiles>
      <SellerShippingProfile><ShippingProfileID>${esc(setup.fulfillmentPolicyId)}</ShippingProfileID></SellerShippingProfile>
      <SellerReturnProfile><ReturnProfileID>${esc(setup.returnPolicyId)}</ReturnProfileID></SellerReturnProfile>
      <SellerPaymentProfile><PaymentProfileID>${esc(setup.paymentPolicyId)}</PaymentProfileID></SellerPaymentProfile>
    </SellerProfiles>
    <ShippingPackageDetails>
      <MeasurementUnit>English</MeasurementUnit>
      <ShippingPackage>PackageThickEnvelope</ShippingPackage>
      <WeightMajor unit="lbs">${Math.floor(pkg.weightOz / 16)}</WeightMajor>
      <WeightMinor unit="oz">${Math.round(pkg.weightOz % 16)}</WeightMinor>
      <PackageLength unit="inches">${pkg.lengthIn}</PackageLength>
      <PackageWidth unit="inches">${pkg.widthIn}</PackageWidth>
      <PackageDepth unit="inches">${pkg.heightIn}</PackageDepth>
    </ShippingPackageDetails>
    <BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails>
    <ListingDetails>
      <BestOfferAutoAcceptPrice currencyID="USD">${autoAccept.toFixed(2)}</BestOfferAutoAcceptPrice>
      <MinimumBestOfferPrice currencyID="USD">${minOffer.toFixed(2)}</MinimumBestOfferPrice>
    </ListingDetails>
  </Item>`;
  };

  // 4. Verify (no listing created) — fixes what it can, then checks fees.
  let verify: TradingResp | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    verify = await tradingCall(accessToken, "VerifyAddFixedPriceItem", itemXml());
    const errs = hardErrors(verify);
    if (!errs.length) break;
    const msgs = errs.map((e) => e.message).join(" | ");

    const missing = [...msgs.matchAll(/item specific ([^|.,;]+?) is missing/gi)].map((m) => m[1].trim());
    if (missing.length && addMissingAspects(aspects, missing).length) continue;

    if (/condition/i.test(msgs) && condIdx < conditionIds.length - 1) {
      condIdx++;
      continue;
    }
    if (/leaf category|category is not valid|invalid category/i.test(msgs) && fbIdx < fallbacks.length) {
      catId = fallbacks[fbIdx++];
      continue;
    }
    break;
  }
  if (!verify || hardErrors(verify).length) {
    console.error(`[ebay/schedule] verify failed sku=${sku}: ${verify?.text.slice(0, 2000)}`);
    return { success: false, sku, error: verify ? errorText(verify) : "eBay did not respond." };
  }

  const fees = totalFees(verify.fees);
  const feeBreakdown = verify.fees.filter((f) => f.amount > 0 && f.name !== "ListingFee");
  if (fees > 0) {
    return {
      success: false,
      sku,
      listingFees: fees,
      feeBreakdown,
      error: `Not scheduled: eBay would charge $${fees.toFixed(2)} in listing fees (${feeBreakdown
        .map((f) => `${f.name} $${f.amount.toFixed(2)}`)
        .join(", ")}).`,
    };
  }

  // 5. Create the scheduled listing.
  const add = await tradingCall(accessToken, "AddFixedPriceItem", itemXml());
  if (hardErrors(add).length && !add.itemId) {
    console.error(`[ebay/schedule] add failed sku=${sku}: ${add.text.slice(0, 2000)}`);
    return { success: false, sku, error: errorText(add) };
  }

  const warnings = add.errors.filter((e) => e.severity === "Warning").map((e) => e.message);
  console.log("[ebay/schedule] scheduled", { sku, itemId: add.itemId, startAt: startAt.toISOString(), price });
  return {
    success: true,
    sku,
    itemId: add.itemId,
    scheduledFor: startAt.toISOString(),
    listingFees: totalFees(add.fees),
    warnings: warnings.length ? warnings : undefined,
  };
}
