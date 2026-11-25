"use client";

import { useEffect, useMemo, useState } from "react";
import { SIZE_REQUIRED_CATEGORIES } from "@/lib/categories";
import { normalizePrice } from "@/lib/pricing";
import {
  PACKAGE_GROUP_LABELS,
  guessPackageGroup,
  minimumPrice,
} from "@/lib/package";
import type { ItemGroup, ListingResult, PackageGroup, Photo } from "@/lib/types";

// Default go-live time for scheduling: 7 days out, on the hour.
export function defaultScheduleAt(): string {
  const d = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

// ISO ↔ <input type="datetime-local"> (which works in local time).
function isoToLocalInput(iso: string | undefined): string {
  const d = new Date(iso || "");
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

// eBay sold-listings search for the tight string, filtered to the item's
// condition (new vs pre-owned), and Terapeak for the broad string (90 days).
function soldSearchUrl(q: string, condition: string | undefined): string {
  const cond = /^NEW/.test(condition || "") ? "1000|1500" : "3000";
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&LH_ItemCondition=${encodeURIComponent(cond)}`;
}

function terapeakUrl(q: string): string {
  return `https://www.ebay.com/sh/research?marketplace=EBAY-US&tabName=SOLD&dayRange=90&keywords=${encodeURIComponent(q)}`;
}

function toNum(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

const TITLE_LIMIT = 80;

// The seller lists used items as Pre-owned · Good (upgrading by hand in Seller
// Hub when one deserves it); the server maps anything better than Good to Good.
const CONDITIONS: { value: string; label: string }[] = [
  { value: "NEW_WITH_TAGS", label: "New with tags" },
  { value: "GOOD", label: "Pre-owned · Good" },
  { value: "FAIR", label: "Pre-owned · Fair" },
];

function formatPrice(value: ListingResult["suggested_price"]): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (n === undefined || Number.isNaN(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

function priceToInput(value: ListingResult["suggested_price"]): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  return n === undefined || Number.isNaN(n) ? "" : String(n);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="btn-ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {copied ? "✓ Copied" : `📋 Copy ${label}`}
    </button>
  );
}

interface ListingCardProps {
  group: ItemGroup;
  photoById: (id: string) => Photo | undefined;
  ebayConnected: boolean;
  onEdit: (groupId: string, patch: Partial<ListingResult>) => void;
  onRetry: (groupId: string) => void;
  onPost: (groupId: string) => void;
  onPublishAndPromote: (groupId: string) => void;
  onSchedule: (groupId: string) => void;
}

export function ListingCard({
  group,
  photoById,
  ebayConnected,
  onEdit,
  onRetry,
  onPost,
  onPublishAndPromote,
  onSchedule,
}: ListingCardProps) {
  const [open, setOpen] = useState(true);
  const listing = group.listing;
  const cover = photoById(group.photoIds[0]);

  const specifics = useMemo(() => {
    const entries = Object.entries(listing?.item_specifics ?? {});
    return entries.filter(([k, v]) => v && v.trim() !== "" && !k.startsWith("---"));
  }, [listing?.item_specifics]);

  const titleLen = listing?.title?.length ?? 0;

  // Rule Set A checks: 70–80 characters, and for clothing/shoes the gender word
  // has to end inside the first 50 characters.
  const titleCheck = useMemo(() => {
    const t = listing?.title ?? "";
    const m = t.match(/\b(womens|women's|women|mens|men's|men|unisex|boys|girls|kids)\b/i);
    const genderEnd = m && m.index !== undefined ? m.index + m[0].length : 0;
    const needsGender = /^(womens_|mens_)/.test(listing?.category ?? "");
    const notes: string[] = [];
    if (t.length && t.length < 70) notes.push("under 70 characters");
    if (needsGender && !genderEnd) notes.push("no gender word");
    else if (genderEnd > 50) notes.push(`gender ends at character ${genderEnd} (must be ≤ 50)`);
    return { genderEnd, notes };
  }, [listing?.title, listing?.category]);

  // eBay's size standardization blocks apparel/footwear listings that are
  // missing a Size, so flag those for the seller before they post.
  const sizeRequired = SIZE_REQUIRED_CATEGORIES.has(listing?.category ?? "");
  const sizeMissing = sizeRequired && !(listing?.size ?? "").trim();

  return (
    <article className={`listing-card status-${group.status}`}>
      <header className="listing-card-head" onClick={() => setOpen((o) => !o)}>
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="listing-cover" src={cover.previewUrl} alt="" />
        )}
        <div className="listing-card-title">
          <strong>
            {group.sku && <span className="sku-tag">{group.sku}</span>}
            {listing?.title || group.name}
          </strong>
          <span className="listing-card-sub">
            {group.status === "writing" && (
              <>
                <span className="spinner small" aria-hidden="true" /> Writing…
              </>
            )}
            {group.status === "done" && (
              <>✅ {formatPrice(listing?.suggested_price)} · ready</>
            )}
            {group.status === "error" && (
              <span style={{ color: "var(--color-danger)" }}>
                ⚠️ {group.postError || "Failed"}
              </span>
            )}
            {group.status === "idle" && "Waiting…"}
          </span>
        </div>
        {group.status === "error" ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={(e) => {
              e.stopPropagation();
              onRetry(group.id);
            }}
          >
            ↻ Retry
          </button>
        ) : (
          <span className="chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
        )}
      </header>

      {open && listing && group.status === "done" && (
        <div className="listing-card-body">
          <div className="result-field">
            <label>
              Title
              <span className={`count${titleLen > TITLE_LIMIT ? " over" : ""}`}>
                {titleLen}/{TITLE_LIMIT}
                {titleCheck.genderEnd > 0 && ` · gender ends at ${titleCheck.genderEnd}`}
              </span>
              {titleCheck.notes.length > 0 && (
                <span className="count over"> ⚠️ {titleCheck.notes.join(", ")}</span>
              )}
            </label>
            <input
              type="text"
              className="title-input"
              value={listing.title}
              onChange={(e) => onEdit(group.id, { title: e.target.value })}
            />
            <div className="copy-row">
              <CopyButton text={listing.title} label="title" />
            </div>
          </div>

          <div className="meta-row">
            <div className="stat editable">
              <label className="k" htmlFor={`price-${group.id}`}>
                Price
              </label>
              <div className="price-input">
                <span aria-hidden="true">$</span>
                <input
                  id={`price-${group.id}`}
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={priceToInput(listing.suggested_price)}
                  onChange={(e) =>
                    onEdit(group.id, {
                      suggested_price:
                        e.target.value === "" ? "" : Number(e.target.value),
                    })
                  }
                  // Snap to the house .89 ending once the seller is done typing,
                  // so the field matches what actually publishes to eBay. An
                  // empty field stays empty.
                  onBlur={(e) => {
                    const snapped = normalizePrice(e.target.value);
                    if (snapped !== undefined) {
                      onEdit(group.id, { suggested_price: snapped });
                    }
                  }}
                />
              </div>
            </div>
            <div className="stat editable">
              <label className="k" htmlFor={`cond-${group.id}`}>
                Condition
              </label>
              <select
                id={`cond-${group.id}`}
                value={
                  ["NEW_WITH_TAGS", "FAIR"].includes(String(listing.condition)) ? listing.condition : "GOOD"
                }
                onChange={(e) => onEdit(group.id, { condition: e.target.value })}
              >
                {/* Keep an unexpected model value selectable rather than losing it. */}
                {CONDITIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            {listing.brand && (
              <div className="stat">
                <div className="k">Brand</div>
                <div className="v">{listing.brand}</div>
              </div>
            )}
            {(sizeRequired || listing.size) && (
              <div className={`stat editable${sizeMissing ? " needs-attention" : ""}`}>
                <label className="k" htmlFor={`size-${group.id}`}>
                  Size
                </label>
                <input
                  id={`size-${group.id}`}
                  type="text"
                  className="size-input"
                  value={listing.size ?? ""}
                  placeholder={sizeRequired ? "e.g. M, 32x34, 10.5" : "—"}
                  onChange={(e) => onEdit(group.id, { size: e.target.value })}
                />
              </div>
            )}
          </div>

          {sizeMissing && (
            <p className="size-warning" role="alert">
              ⚠️ No size found on the tag. eBay now blocks apparel listings
              without a standard size — check the photos or measure the item,
              then fill in Size above before posting.
            </p>
          )}

          <div className="result-field">
            <label>Description</label>
            <textarea
              value={listing.description}
              onChange={(e) => onEdit(group.id, { description: e.target.value })}
              rows={8}
            />
            <div className="copy-row">
              <CopyButton text={listing.description} label="description" />
            </div>
          </div>

          {specifics.length > 0 && (
            <details className="specifics-details">
              <summary>{specifics.length} item specifics</summary>
              <div className="specifics">
                {specifics.map(([k, v]) => (
                  <div className="row" key={k}>
                    <span className="k">{k}</span>
                    <span>{v}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Price research: Rule Set A search strings */}
          {(listing.sold_search || listing.terapeak_search) && (
            <div className="research-strings">
              {listing.sold_search && (
                <div className="result-field">
                  <label>Sold search (tight)</label>
                  <input
                    type="text"
                    value={listing.sold_search}
                    onChange={(e) => onEdit(group.id, { sold_search: e.target.value })}
                  />
                  <div className="copy-row">
                    <CopyButton text={listing.sold_search} label="sold search" />
                    <a
                      className="btn-ghost"
                      href={soldSearchUrl(listing.sold_search, listing.condition)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      🔎 Open eBay sold search ↗
                    </a>
                  </div>
                </div>
              )}
              {listing.terapeak_search && (
                <div className="result-field">
                  <label>Terapeak search (broad)</label>
                  <input
                    type="text"
                    value={listing.terapeak_search}
                    onChange={(e) => onEdit(group.id, { terapeak_search: e.target.value })}
                  />
                  <div className="copy-row">
                    <CopyButton text={listing.terapeak_search} label="Terapeak search" />
                    <a
                      className="btn-ghost"
                      href={terapeakUrl(listing.terapeak_search)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      📊 Open Terapeak ↗
                    </a>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Scheduling: the seller's own ID, price, package and go-live time */}
          {(() => {
            const pkgGroup: PackageGroup = listing.package_group || guessPackageGroup(listing);
            const price = toNum(listing.list_price);
            const cost = toNum(listing.cost);
            const floor = cost > 0 ? minimumPrice(cost) : NaN;
            const belowFloor = price > 0 && floor > 0 && price < floor;
            return (
              <div className="schedule-fields">
                <div className="meta-row">
                  <div className={`stat editable${listing.custom_label?.trim() ? "" : " needs-attention"}`}>
                    <label className="k" htmlFor={`label-${group.id}`}>Your SKU / temp ID</label>
                    <input
                      id={`label-${group.id}`}
                      type="text"
                      value={listing.custom_label ?? ""}
                      placeholder="BQ 2726 or 1124-01"
                      onChange={(e) => onEdit(group.id, { custom_label: e.target.value })}
                    />
                  </div>
                  <div className={`stat editable${price > 0 ? "" : " needs-attention"}`}>
                    <label className="k" htmlFor={`lp-${group.id}`}>Your eBay price</label>
                    <div className="price-input">
                      <span aria-hidden="true">$</span>
                      <input
                        id={`lp-${group.id}`}
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={listing.list_price ?? ""}
                        placeholder="24.89"
                        onChange={(e) =>
                          onEdit(group.id, {
                            list_price: e.target.value === "" ? "" : Number(e.target.value),
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="stat editable">
                    <label className="k" htmlFor={`cost-${group.id}`}>Cost (optional)</label>
                    <div className="price-input">
                      <span aria-hidden="true">$</span>
                      <input
                        id={`cost-${group.id}`}
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={listing.cost ?? ""}
                        onChange={(e) =>
                          onEdit(group.id, { cost: e.target.value === "" ? "" : Number(e.target.value) })
                        }
                      />
                    </div>
                  </div>
                </div>
                <p className="post-hint">
                  AI price guess (not from sold comps): {formatPrice(listing.suggested_price)}
                  {floor > 0 && <> · Your minimum for this cost: ${floor.toFixed(2)}</>}
                </p>
                {belowFloor && (
                  <p className="size-warning" role="alert">
                    ⚠️ ${price.toFixed(2)} is below your minimum of ${floor.toFixed(2)} for a
                    ${cost.toFixed(2)} item.
                  </p>
                )}
                <div className="meta-row">
                  <div className="stat editable">
                    <label className="k" htmlFor={`pkg-${group.id}`}>Package</label>
                    <select
                      id={`pkg-${group.id}`}
                      value={pkgGroup}
                      onChange={(e) => onEdit(group.id, { package_group: e.target.value as PackageGroup })}
                    >
                      {(Object.keys(PACKAGE_GROUP_LABELS) as PackageGroup[]).map((g) => (
                        <option key={g} value={g}>
                          {PACKAGE_GROUP_LABELS[g]}
                        </option>
                      ))}
                    </select>
                  </div>
                  {pkgGroup === "custom" &&
                    ([
                      ["package_weight_oz", "Weight (oz)"],
                      ["package_length_in", "Length (in)"],
                      ["package_width_in", "Width (in)"],
                      ["package_height_in", "Height (in)"],
                    ] as const).map(([key, label]) => (
                      <div
                        key={key}
                        className={`stat editable${toNum(listing[key]) > 0 ? "" : " needs-attention"}`}
                      >
                        <label className="k" htmlFor={`${key}-${group.id}`}>{label}</label>
                        <input
                          id={`${key}-${group.id}`}
                          type="number"
                          min="0"
                          step="1"
                          inputMode="decimal"
                          value={listing[key] ?? ""}
                          onChange={(e) =>
                            onEdit(group.id, {
                              [key]: e.target.value === "" ? "" : Number(e.target.value),
                            } as Partial<ListingResult>)
                          }
                        />
                      </div>
                    ))}
                  <div className="stat editable">
                    <label className="k" htmlFor={`when-${group.id}`}>Goes live</label>
                    <input
                      id={`when-${group.id}`}
                      type="datetime-local"
                      value={isoToLocalInput(listing.schedule_at || defaultScheduleAt())}
                      onChange={(e) => onEdit(group.id, { schedule_at: localInputToIso(e.target.value) })}
                    />
                  </div>
                </div>
              </div>
            );
          })()}

          {/* eBay posting */}
          {group.postStatus === "scheduled" ? (
            <p className="post-result ok">
              📅 Scheduled on eBay for{" "}
              {group.scheduledFor ? new Date(group.scheduledFor).toLocaleString() : "later"}
              {typeof group.listingFees === "number" && ` · listing fees $${group.listingFees.toFixed(2)}`}
              {" · "}review it in{" "}
              <a
                href="https://www.ebay.com/sh/lst/scheduled"
                target="_blank"
                rel="noopener noreferrer"
              >
                Seller Hub → Scheduled ↗
              </a>
              {group.scheduleNotes?.length ? (
                <ul className="post-hint">
                  {group.scheduleNotes.map((n) => (
                    <li key={n}>⚠️ {n}</li>
                  ))}
                </ul>
              ) : null}
            </p>
          ) : group.postStatus === "draft-saved" ? (
            <p className="post-result ok">
             ✅ Saved as eBay Draft
            </p>
          ) : group.postStatus === "published" ? (
            <div className="post-row">
              <p className="post-result ok">
                {group.promoted ? "✅ Published + promoted (3%)" : "✅ Published to eBay"}
                {group.listingId ? (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={`https://www.ebay.com/itm/${group.listingId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View listing ↗
                    </a>
                  </>
                ) : null}
              </p>
              {/* Live but not advertised — without this the failure is invisible. */}
              {!group.promoted && group.promoteError && (
                <p className="post-result err">⚠️ Not promoted: {group.promoteError}</p>
              )}
            </div>
          ) : ebayConnected ? (
            <div className="post-row">
              <div className="post-buttons">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onSchedule(group.id)}
                  disabled={group.postStatus === "saving"}
                >
                  {group.postStatus === "saving" && group.postMode === "schedule" ? (
                    <>
                      <span className="spinner" aria-hidden="true" /> Scheduling…
                    </>
                  ) : (
                    "📅 Schedule on eBay"
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onPost(group.id)}
                  disabled={group.postStatus === "saving"}
                >
                  {group.postStatus === "saving" && group.postMode === "draft" ? (
                    <>
                      <span className="spinner" aria-hidden="true" /> Posting to eBay…
                    </>
                  ) : (
                    "🚀 💾 Save as eBay Draft"
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onPublishAndPromote(group.id)}
                  disabled={group.postStatus === "saving"}
                >
                  {group.postStatus === "saving" && group.postMode === "promote" ? (
                    <>
                      <span className="spinner" aria-hidden="true" /> Publishing…
                    </>
                  ) : (
                    "🚀 Publish + Promote 3%"
                  )}
                </button>
              </div>
              {group.postStatus === "error" && group.postError && (
                <p className="post-result err">⚠️ {group.postError}</p>
              )}
            </div>
          ) : (
            <p className="post-hint">Connect eBay (top of page) to post this listing.</p>
          )}
        </div>
      )}
    </article>
  );
}
