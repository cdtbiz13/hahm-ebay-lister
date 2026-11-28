// Shape of a generated listing. Mirrors the JSON the model returns in the
// Python script's analyze_photos(), plus the routed profile.

export interface ListingResult {
  title: string;
  category?: string;
  category_hint?: string;
  category_id?: string;
  brand?: string;
  item_type?: string;
  color?: string[] | string;
  size?: string;
  material?: string;
  condition?: string;
  condition_notes?: string;
  measurements?: string;
  description: string;
  suggested_price?: number | string;
  seo_keywords?: string[];
  key_features?: string[];
  item_specifics?: Record<string, string>;
  item_profile?: string;
  // Rule Set A research strings: tight = eBay sold search, broad = Terapeak.
  sold_search?: string;
  terapeak_search?: string;

  // ── Seller-entered fields for scheduled listings ───────────────────────────
  // The seller's own ID (clothing SKU sticker like "BQ 2726", or a temp ID like
  // "1124-01"). Sent to eBay as Custom label so Flyp and the tracker can match.
  custom_label?: string;
  // The seller's eBay price from their own sold-comp research. Required to
  // schedule; suggested_price (the AI's guess) is never used for scheduling.
  list_price?: number | string;
  // What the seller paid, for the minimum-price warning. Optional.
  cost?: number | string;
  // Package group from the seller's weight table, or "custom" to enter it.
  package_group?: PackageGroup;
  package_weight_oz?: number | string;
  package_length_in?: number | string;
  package_width_in?: number | string;
  package_height_in?: number | string;
  // When the listing should go live, as an ISO timestamp (UTC).
  schedule_at?: string;
}

export type PackageGroup = "light" | "heavy" | "custom";

export interface AnalyzeRequestBody {
  // Browser-resized JPEG data URLs or raw base64 strings.
  images: { mediaType: string; data: string }[];
  profile: string;
  // Optional model overrides; server falls back to its defaults when omitted.
  analysisModel?: string;
  routerModel?: string;
  // Short ID line from intake ("Madewell Skinny Jeans Womens Dark Wash 30").
  hint?: string;
}

export interface AnalyzeResponse {
  ok: boolean;
  listing?: ListingResult;
  error?: string;
}

export interface SortResponse {
  ok: boolean;
  groups?: { name: string; photoIndices: number[] }[];
  orphanIndices?: number[];
  error?: string;
}

// ── Client-side working model for the bulk flow ──────────────────────────────
export interface Photo {
  id: string;
  mediaType: string;
  data: string;
  previewUrl: string;
}

export type ItemStatus =
  | "idle"
  | "writing"
  | "done"
  | "error";

export type PostStatus =
  | "idle"
  | "saving"
  | "draft-saved"
  // Published live and enrolled in a Promoted Listings campaign.
  | "published"
  // Scheduled on eBay (shows in Seller Hub → Listings → Scheduled).
  | "scheduled"
  | "error";

// Which action is in flight / produced the current state. Both buttons share
// postStatus, so without this each one can't tell whether the spinner is its own.
export type PostMode = "draft" | "promote" | "schedule";

export interface ItemGroup {
  id: string;
  sku: string;
  name: string;
  photoIds: string[];
  listing?: ListingResult;
  status: ItemStatus;

  // eBay draft state
  postStatus?: PostStatus;
  postMode?: PostMode;
  offerId?: string;
  listingId?: string;
  postError?: string;

  // Promote-only. A listing can go live but fail to enrol in the ad campaign,
  // so promoted=false with a reason is a distinct outcome from success.
  promoted?: boolean;
  promoteError?: string;

  // Schedule-only. When the listing goes live (ISO), and the listing fees eBay
  // quoted for it (should be $0.00).
  scheduledFor?: string;
  listingFees?: number;

  // SKU / temp ID typed on the upload slot; pre-fills the listing's
  // custom_label once it's written.
  presetLabel?: string;

  // Notes from scheduling (e.g. item specifics to check in Seller Hub).
  scheduleNotes?: string[];

  // Linked intake item (logged when bought). On schedule, its tracker row gets
  // the SKU, final title and eBay price.
  intakeTempId?: string;
  intakeCost?: number;
  intakeHint?: string;
}