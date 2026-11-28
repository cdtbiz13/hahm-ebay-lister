"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiPost } from "@/lib/api-client";
import { getAnalysisModel, getSortModel } from "@/lib/model-preferences";
import { resizeImage } from "@/lib/resize";
import { buildSku } from "@/lib/sku";
import { EbayConnect } from "./EbayConnect";
import { ModelSelector } from "./ModelSelector";
import { ReviewBoard } from "./ReviewBoard";
import { ListingsView } from "./ListingsView";
import { defaultScheduleAt } from "./ListingCard";
import { AwaitingList } from "./AwaitingList";
import { AppNav } from "./AppNav";
import type { AwaitingItem } from "@/lib/intake-client";
import type {
  AnalyzeResponse,
  ItemGroup,
  ListingResult,
  Photo,
  PostMode,
  SortResponse,
} from "@/lib/types";
type Step = "upload" | "review" | "listings";
// Big batches are sorted in chunks of SORT_CHUNK photos per request — each
// chunk's thumbnail payload stays under Vercel's 4.5 MB body limit — then
// stitched back together with a merge check at every chunk boundary.
const MAX_PHOTOS = 300;
const SORT_CHUNK = 100;
const WRITE_CONCURRENCY = 3;
// One upload box per item, so photos never need AI sorting.
const ITEM_SLOTS = 10;
// eBay accepts at most 12 photos per listing; sending more just bloats the
// publish request toward Vercel's body limit.
// eBay allows 24 photos per listing. They're uploaded to eBay a few at a
// time first (see /api/ebay/photos), so no request gets too big.
const MAX_PUBLISH_PHOTOS = 24;
const PHOTO_UPLOAD_BATCH = 4;

// "draft" leaves the offer unpublished; "promote" publishes it live and enrols
// the listing in a Promoted Listings campaign. Same request payload either way.
const POST_ENDPOINTS: Record<PostMode, string> = {
  draft: "/api/ebay/publish",
  promote: "/api/ebay/publish-and-promote",
  schedule: "/api/ebay/schedule",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Math.floor(performance.now() * 1000)}-${Math.random()}`;
}

// Parse a fetch response as JSON, but turn non-JSON error bodies (e.g. a 413
// "Request Entity Too Large" plain-text page) into a friendly message instead
// of a cryptic "Unexpected token" error.
async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (res.status === 413) {
      throw new Error(
        "That was too much photo data to send at once. Try sorting fewer photos per batch."
      );
    }
    throw new Error(
      text.trim().slice(0, 140) || `Request failed (${res.status}).`
    );
  }
}

// Run async workers over items with a fixed concurrency limit.
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

export default function Home() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [binPrefix, setBinPrefix] = useState("");
  const [step, setStep] = useState<Step>("upload");
  const [groups, setGroups] = useState<ItemGroup[]>([]);
  const [orphanIds, setOrphanIds] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [sortProgress, setSortProgress] = useState<string | null>(null);
  // Where bin lettering starts — continues after SKUs already on eBay, so a
  // second batch from bin K31 gets K31-N… instead of colliding with K31-A.
  const [skuStart, setSkuStart] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ebayConnected, setEbayConnected] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const photoMap = useMemo(() => {
    const m = new Map<string, Photo>();
    photos.forEach((p) => m.set(p.id, p));
    return m;
  }, [photos]);
  const photoById = useCallback((id: string) => photoMap.get(id), [photoMap]);

  // Latest groups, readable inside async workers without stale closures.
  const groupsRef = useRef(groups);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  // Keep eBay connection status in sync (also after the connect bar updates).
  useEffect(() => {
    const check = () =>
      fetch("/api/ebay/status", { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => setEbayConnected(Boolean(d.connected)))
        .catch(() => setEbayConnected(false));
    check();
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // ── Upload ──────────────────────────────────────────────
  const addFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) {
      setError("Those didn't look like photos. Use JPG, PNG, or WebP.");
      return;
    }
    try {
      const resized = await Promise.all(files.map(resizeImage));
      setPhotos((prev) =>
        [...prev, ...resized.map((r) => ({ id: newId(), ...r }))].slice(
          0,
          MAX_PHOTOS
        )
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const removePhoto = (id: string) => {
    setPhotos((prev) => prev.filter((p) => p.id !== id));
    setSlots((prev) => prev.map((sl) => ({ ...sl, photoIds: sl.photoIds.filter((x) => x !== id) })));
  };

  // ── Item slots: one box per item, no sorting ────────────
  const [slots, setSlots] = useState<
    { label: string; photoIds: string[]; intake?: AwaitingItem }[]
  >(() => Array.from({ length: ITEM_SLOTS }, () => ({ label: "", photoIds: [] })));
  // Which item box is choosing its intake item (null = picker closed).
  const [pickerSlot, setPickerSlot] = useState<number | null>(null);

  const attachIntake = (slot: number, item: AwaitingItem | undefined) => {
    setSlots((prev) =>
      prev.map((sl, i) => {
        if (i !== slot) return sl;
        // Default the box's ID to the temp ID; for clothing, type the sticker SKU over it.
        const wasTemp = sl.intake && sl.label.trim() === sl.intake.tempId;
        const label = item
          ? sl.label.trim() && !wasTemp
            ? sl.label
            : item.tempId
          : wasTemp
            ? ""
            : sl.label;
        return { ...sl, intake: item, label };
      })
    );
    setPickerSlot(null);
  };
  const [slotDrag, setSlotDrag] = useState<number | null>(null);

  const addFilesToSlot = useCallback(async (slot: number, fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) {
      setError("Those didn't look like photos. Use JPG, PNG, or WebP.");
      return;
    }
    try {
      const resized = await Promise.all(files.map(resizeImage));
      const added = resized.map((r) => ({ id: newId(), ...r }));
      setPhotos((prev) => [...prev, ...added]);
      setSlots((prev) =>
        prev.map((sl, i) =>
          i === slot ? { ...sl, photoIds: [...sl.photoIds, ...added.map((a) => a.id)] } : sl
        )
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Move a photo to the end of its item (e.g. the SKU sticker shot).
  const movePhotoToEnd = (slot: number, id: string) =>
    setSlots((prev) =>
      prev.map((sl, i) =>
        i === slot ? { ...sl, photoIds: [...sl.photoIds.filter((x) => x !== id), id] } : sl
      )
    );

  const filledSlots = slots.filter((sl) => sl.photoIds.length > 0).length;
  const slottedIds = useMemo(() => new Set(slots.flatMap((sl) => sl.photoIds)), [slots]);
  // Photos added through the bulk dropzone (not in an item box).
  const bulkPhotos = useMemo(() => photos.filter((p) => !slottedIds.has(p.id)), [photos, slottedIds]);

  // Master button: every filled box becomes one item; write them all now.
  const writeSlots = async () => {
    const next: ItemGroup[] = slots
      .map((sl, i) => ({ sl, i }))
      .filter(({ sl }) => sl.photoIds.length > 0)
      .map(({ sl, i }, n) => ({
        id: newId(),
        sku: sl.label.trim() || buildSku(binPrefix, n),
        name: `Item ${i + 1}`,
        photoIds: sl.photoIds,
        status: "idle",
        presetLabel: sl.label.trim() || undefined,
        intakeTempId: sl.intake?.tempId,
        intakeCost: sl.intake?.cost,
        intakeHint: sl.intake?.idLine,
      }));
    if (next.length === 0) return;
    groupsRef.current = next;
    setGroups(next);
    setOrphanIds([]);
    setStep("listings");
    await runPool(next.map((g) => g.id), WRITE_CONCURRENCY, writeGroup);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void addFiles(e.dataTransfer.files);
  };

  // ── Sort ────────────────────────────────────────────────
  const sort = async () => {
    // Only the photos dropped in the bulk box — item boxes are already sorted.
    const photos = bulkPhotos;
    if (photos.length === 0) return;
    setSorting(true);
    setError(null);
    try {
      // Continue bin lettering after any SKUs already on eBay for this bin.
      let skuOffset = 0;
      if (binPrefix.trim()) {
        try {
          const r = await apiPost("/api/ebay/next-sku", { prefix: binPrefix.trim() });
          const d = (await readJson(r)) as { ok?: boolean; nextIndex?: number };
          if (d.ok && Number.isInteger(d.nextIndex) && (d.nextIndex as number) > 0) {
            skuOffset = d.nextIndex as number;
          }
        } catch {
          /* not connected or lookup failed — start at A like before */
        }
      }

      // Sort in chunks so each request's thumbnail payload stays small.
      type RawGroup = { name: string; photoIds: string[] };
      const chunkResults: RawGroup[][] = [];
      const orphanIdsAll: string[] = [];
      for (let off = 0; off < photos.length; off += SORT_CHUNK) {
        const chunk = photos.slice(off, off + SORT_CHUNK);
        if (photos.length > SORT_CHUNK) {
          setSortProgress(
            `Sorting photos ${off + 1}–${off + chunk.length} of ${photos.length}…`
          );
        }
        const res = await apiPost("/api/sort", {
          // Use the small thumbnail for sorting to keep the payload small.
          images: chunk.map((p) => ({
            mediaType: p.mediaType,
            data: p.previewUrl.split(",")[1],
          })),
          sortModel: getSortModel() ?? undefined,
        });
        const data = (await readJson(res)) as SortResponse;
        if (!data.ok || !data.groups) {
          throw new Error(data.error || "Could not sort the photos.");
        }
        const idxToId = (i: number) => chunk[i]?.id;
        chunkResults.push(
          data.groups
            .map((g) => ({
              name: g.name,
              photoIds: g.photoIndices.map(idxToId).filter(Boolean) as string[],
            }))
            .filter((g) => g.photoIds.length > 0)
        );
        orphanIdsAll.push(
          ...((data.orphanIndices ?? []).map(idxToId).filter(Boolean) as string[])
        );
      }

      // Stitch chunks back together: an item photographed across a chunk
      // boundary lands split in two — ask the model whether the group holding
      // the boundary's last photo and the one holding the next chunk's first
      // photo are actually the same item.
      const merged: RawGroup[] = [...(chunkResults[0] ?? [])];
      for (let c = 1; c < chunkResults.length; c++) {
        const rest = [...chunkResults[c]];
        const lastId = photos[c * SORT_CHUNK - 1]?.id;
        const firstId = photos[c * SORT_CHUNK]?.id;
        const prevGroup = merged.find((g) => lastId && g.photoIds.includes(lastId));
        const nextGroup = rest.find((g) => firstId && g.photoIds.includes(firstId));
        if (prevGroup && nextGroup) {
          setSortProgress("Checking for items split across batches…");
          try {
            const a = photoMap.get(prevGroup.photoIds[0]);
            const b = photoMap.get(nextGroup.photoIds[0]);
            if (a && b) {
              const res = await apiPost("/api/merge-check", {
                a: { mediaType: a.mediaType, data: a.previewUrl.split(",")[1] },
                b: { mediaType: b.mediaType, data: b.previewUrl.split(",")[1] },
                countA: prevGroup.photoIds.length,
                countB: nextGroup.photoIds.length,
                sortModel: getSortModel() ?? undefined,
              });
              const d = (await readJson(res)) as { ok?: boolean; merge?: boolean };
              if (d.ok && d.merge) {
                prevGroup.photoIds = [...prevGroup.photoIds, ...nextGroup.photoIds];
                rest.splice(rest.indexOf(nextGroup), 1);
              }
            }
          } catch {
            /* boundary check is best-effort — worst case the item stays split */
          }
        }
        merged.push(...rest);
      }

      const assigned = new Set<string>();
      merged.forEach((g) => g.photoIds.forEach((id) => assigned.add(id)));
      orphanIdsAll.forEach((id) => assigned.add(id));
      // Any photo the sorter never placed shouldn't vanish — surface it.
      const leftover = photos.filter((p) => !assigned.has(p.id)).map((p) => p.id);

      const nextGroups: ItemGroup[] = merged.map((g, i) => ({
        id: newId(),
        sku: buildSku(binPrefix, skuOffset + i),
        name: g.name,
        photoIds: g.photoIds,
        status: "idle",
      }));
      setSkuStart(skuOffset);
      setGroups(nextGroups);
      setOrphanIds([...orphanIdsAll, ...leftover]);
      setStep("review");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSorting(false);
      setSortProgress(null);
    }
  };

  // ── One item: skip AI sorting ───────────────────────────
  // Every uploaded photo is one item, in upload order. No sorting call, so
  // nothing can be split or mixed up — upload, write, review, schedule.
  const useAsOneItem = () => {
    const photos = bulkPhotos;
    if (photos.length === 0) return;
    setError(null);
    setSkuStart(0);
    setGroups([
      {
        id: newId(),
        sku: buildSku(binPrefix, 0),
        name: "Item",
        photoIds: photos.map((p) => p.id),
        status: "idle",
      },
    ]);
    setOrphanIds([]);
    setStep("review");
  };

  // ── Review edits ────────────────────────────────────────
  const rename = (groupId: string, name: string) =>
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, name } : g))
    );

  const renameSku = (groupId: string, sku: string) =>
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, sku } : g))
    );

  const movePhoto = (photoId: string, toGroupId: string | "orphans") => {
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        photoIds:
          g.id === toGroupId
            ? g.photoIds.includes(photoId)
              ? g.photoIds
              : [...g.photoIds, photoId]
            : g.photoIds.filter((id) => id !== photoId),
      }))
    );
    setOrphanIds((prev) => {
      const without = prev.filter((id) => id !== photoId);
      return toGroupId === "orphans" ? [...without, photoId] : without;
    });
  };

  // Reorder photos within a group. The array order is the eBay photo order
  // (index 0 = cover/gallery image), so this is all that's needed — `writeGroup`
  // and `postGroup` re-derive their image order from `photoIds` at call time.
  const reorderPhoto = (groupId: string, fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= g.photoIds.length ||
          toIndex >= g.photoIds.length
        ) {
          return g;
        }
        const next = [...g.photoIds];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        return { ...g, photoIds: next };
      })
    );
  };

  const deleteGroup = (groupId: string) =>
    setGroups((prev) => {
      const target = prev.find((g) => g.id === groupId);
      if (target && target.photoIds.length > 0) {
        setOrphanIds((o) => [...o, ...target.photoIds]);
      }
      return prev.filter((g) => g.id !== groupId);
    });

  const addGroup = () =>
    setGroups((prev) => [
      ...prev,
      {
        id: newId(),
        sku: buildSku(binPrefix, skuStart + prev.length),
        name: `new-item-${prev.length + 1}`,
        photoIds: [],
        status: "idle",
      },
    ]);

  // ── Write listings ──────────────────────────────────────
  const writeGroup = useCallback(
    async (groupId: string) => {
      // Snapshot this group's photos from the latest state (no stale closure).
      const group = groupsRef.current.find((g) => g.id === groupId);
      if (!group) return;
      const imgs = group.photoIds
        .map((id) => photoMap.get(id))
        .filter((p): p is Photo => Boolean(p))
        .map((p) => ({ mediaType: p.mediaType, data: p.data }));
      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId ? { ...g, status: "writing", error: undefined } : g
        )
      );
      try {
        const res = await apiPost("/api/analyze", {
          profile: "auto",
          images: imgs,
          analysisModel: getAnalysisModel() ?? undefined,
          routerModel: getSortModel() ?? undefined,
          hint: group.intakeHint,
        });
        const data = (await readJson(res)) as AnalyzeResponse;
        if (!data.ok || !data.listing) {
          throw new Error(data.error || "Could not write this listing.");
        }
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  status: "done",
                  listing: {
                    ...data.listing!,
                    custom_label: data.listing!.custom_label || g.presetLabel || undefined,
                    // Cost from intake turns on the minimum-price warning.
                    cost:
                      data.listing!.cost ??
                      (g.intakeCost && g.intakeCost > 0 ? g.intakeCost : undefined),
                  },
                }
              : g
          )
        );
      } catch (e) {
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  status: "error",
                  error: e instanceof Error ? e.message : String(e),
                }
              : g
          )
        );
      }
    },
    [photoMap]
  );

  const writeAll = async () => {
    const usable = groups.filter((g) => g.photoIds.length > 0).map((g) => g.id);
    if (usable.length === 0) return;
    setStep("listings");
    await runPool(usable, WRITE_CONCURRENCY, writeGroup);
  };

  const editListing = (groupId: string, patch: Partial<ListingResult>) =>
    setGroups((prev) =>
      prev.map((g) =>
        g.id === groupId && g.listing
          ? { ...g, listing: { ...g.listing, ...patch } }
          : g
      )
    );

  // After a listing is scheduled or live: put its SKU, final title and eBay
  // price on the intake item's tracker row. Best-effort — the listing itself
  // already succeeded, so a failure here is shown as a note, not an error.
  const linkIntakeRow = useCallback(async (groupId: string) => {
    const g = groupsRef.current.find((x) => x.id === groupId);
    if (!g?.intakeTempId || !g.listing) return;
    let note: string;
    try {
      const res = await apiPost("/api/intake/link", {
        tempId: g.intakeTempId,
        sku: g.listing.custom_label || g.sku,
        title: g.listing.title,
        price: g.listing.list_price,
      });
      const d = (await readJson(res)) as { ok?: boolean; row?: number; error?: string };
      if (!d.ok) throw new Error(d.error || "unknown error");
      note = `Tracker updated: row ${d.row} now ${g.listing.custom_label || g.sku} with title and price.`;
    } catch (e) {
      note = `⚠️ Listing is fine, but the tracker row for ${g.intakeTempId} wasn't updated (${
        (e as Error).message
      }). Update it by hand.`;
    }
    setGroups((prev) =>
      prev.map((x) =>
        x.id === groupId ? { ...x, scheduleNotes: [...(x.scheduleNotes ?? []), note] } : x
      )
    );
  }, []);

  const postGroup = useCallback(
    async (groupId: string, mode: PostMode = "draft") => {
      const group = groupsRef.current.find((g) => g.id === groupId);
      if (!group || !group.listing) return;

      // Failsafe: never send a title over eBay's 80 characters (it would be
      // cut off mid-word). Stop and let Boss shorten it himself.
      const titleLen = (group.listing.title ?? "").length;
      if (titleLen > 80) {
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  postStatus: "error",
                  postMode: mode,
                  postError: `Title is ${titleLen} characters — eBay allows 80. Shorten it, then try again.`,
                }
              : g
          )
        );
        return;
      }

      const images = group.photoIds
        .map((id) => photoMap.get(id))
        .filter((p): p is Photo => Boolean(p))
        .map((p) => ({ mediaType: p.mediaType, data: p.data }))
        .slice(0, MAX_PUBLISH_PHOTOS);

      setGroups((prev) =>
        prev.map((g) =>
          g.id === groupId
            ? { ...g, postStatus: "saving", postMode: mode, postError: undefined }
            : g
        )
      );

      try {
        let data: {
          success: boolean;
          itemId?: string;
          scheduledFor?: string;
          listingFees?: number;
          warnings?: string[];
          offerId?: string;
          listingId?: string;
          error?: string;
          alreadyListed?: boolean;
          promoted?: boolean;
          promoteError?: string;
        } | null = null;
        let hadTransientRetry = false;

        // Upload the photos to eBay in small batches first (keeps each
        // request well under the server's size limit), then list with URLs.
        const imageUrls: string[] = [];
        for (let start = 0; start < images.length; start += PHOTO_UPLOAD_BATCH) {
          const r = await apiPost("/api/ebay/photos", {
            sku: group.listing.custom_label || group.sku,
            start,
            images: images.slice(start, start + PHOTO_UPLOAD_BATCH),
          });
          const d = (await readJson(r)) as { ok?: boolean; urls?: string[]; error?: string };
          if (!d.ok || !d.urls) throw new Error(d.error || "Could not upload photos to eBay.");
          imageUrls.push(...d.urls);
        }

        for (let attempt = 0; ; attempt++) {
          const res = await apiPost(POST_ENDPOINTS[mode], {
            sku: group.sku,
            listing:
              mode === "schedule"
                ? { ...group.listing, schedule_at: group.listing.schedule_at || defaultScheduleAt() }
                : group.listing,
            images: [],
            imageUrls,
          });

          if (
            attempt < 2 &&
            [429, 502, 503, 504].includes(res.status)
          ) {
            hadTransientRetry = true;
            await sleep(res.status === 429 ? 65_000 : 8_000);
            continue;
          }

          data = await readJson(res);
          break;
        }

        // A retried request may discover that the draft already exists.
        if (
          data?.success &&
          data.alreadyListed &&
          hadTransientRetry &&
          data.offerId
        ) {
          data = { success: true, offerId: data.offerId, listingId: "" };
        }

        if (mode === "schedule") {
          if (!data?.success || !data.itemId) {
            throw new Error(data?.error || "eBay did not return an item ID.");
          }
          const sched = data;
          setGroups((prev) =>
            prev.map((g) =>
              g.id === groupId
                ? {
                    ...g,
                    postStatus: "scheduled",
                    listingId: sched.itemId,
                    scheduledFor: sched.scheduledFor,
                    listingFees: sched.listingFees,
                    scheduleNotes: sched.warnings,
                    postError: undefined,
                  }
                : g
            )
          );
          await linkIntakeRow(groupId);
          return;
        }

        if (!data?.success || !data.offerId) {
          throw new Error(data?.error || "eBay did not return an offer ID.");
        }

        const result = data;
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  postStatus: mode === "promote" ? "published" : "draft-saved",
                  offerId: result.offerId,
                  listingId: mode === "promote" ? result.listingId || "" : "",
                  // Promotion is best-effort on the server: the listing can be
                  // live with promoted=false and a reason. Carry both through.
                  promoted: mode === "promote" ? Boolean(result.promoted) : undefined,
                  promoteError: mode === "promote" ? result.promoteError : undefined,
                  postError: undefined,
                }
              : g
          )
        );
        if (mode === "promote") await linkIntakeRow(groupId);
      } catch (e) {
        setGroups((prev) =>
          prev.map((g) =>
            g.id === groupId
              ? {
                  ...g,
                  postStatus: "error",
                  postError: e instanceof Error ? e.message : String(e),
                }
              : g
          )
        );
      }
    },
    [photoMap, linkIntakeRow]
  );

  const publishAndPromoteGroup = useCallback(
    (groupId: string) => postGroup(groupId, "promote"),
    [postGroup]
  );

  const scheduleGroup = useCallback(
    (groupId: string) => postGroup(groupId, "schedule"),
    [postGroup]
  );

  const postAll = async () => {
    const ready = groups
      .filter(
        (g) =>
          g.status === "done" &&
          g.postStatus !== "draft-saved" &&
          // Already live or scheduled — re-posting would create a second listing.
          g.postStatus !== "published" &&
          g.postStatus !== "scheduled"
      )
      .map((g) => g.id);

    if (ready.length === 0) return;
    await runPool(ready, WRITE_CONCURRENCY, postGroup);
  };

  const usableGroups = useMemo(
    () => groups.filter((g) => g.photoIds.length > 0),
    [groups]
  );

  return (
    <main className="wrap">
      <header className="masthead">
        <span className="logo-mark" aria-hidden="true">
          🪄
        </span>
        <div>
          <h1>Listing Writer</h1>
          <p>Upload a pile of photos · auto-sort into items · write every listing.</p>
        </div>
      </header>
      <AppNav current="/" />

      <EbayConnect />

      {step === "upload" && (
        <>
          <section className="hero">
            <h2>
              One box per item. <em>We&rsquo;ll write the listings.</em>
            </h2>
            <p>
              Drop each item&rsquo;s photos into its own box (up to 10 items),
              add its SKU or temp ID, then write them all at once.
            </p>
          </section>

          <section className="panel" aria-labelledby="upload-heading">
            <h2 id="upload-heading" className="section-label">
              1 · Add each item&rsquo;s photos
            </h2>

            <div className="item-slots">
              {slots.map((sl, i) => (
                <div
                  key={i}
                  className={`item-slot${slotDrag === i ? " dragging" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setSlotDrag(i);
                  }}
                  onDragLeave={() => setSlotDrag(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setSlotDrag(null);
                    void addFilesToSlot(i, e.dataTransfer.files);
                  }}
                >
                  <div className="item-slot-head">
                    <strong>Item {i + 1}</strong>
                    <input
                      type="text"
                      placeholder="SKU / temp ID"
                      value={sl.label}
                      onChange={(e) =>
                        setSlots((prev) =>
                          prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x))
                        )
                      }
                    />
                  </div>
                  {sl.intake ? (
                    <div className="intake-chip">
                      {sl.intake.thumb && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={sl.intake.thumb} alt="" />
                      )}
                      <div>
                        <strong>{sl.intake.tempId}</strong> · {sl.intake.idLine}
                        <span className="post-hint">
                          {" "}
                          Cost ${sl.intake.cost.toFixed(2)}. Clothing: type the sticker SKU in the box above.
                        </span>
                      </div>
                      <button type="button" aria-label="Unlink intake item" onClick={() => attachIntake(i, undefined)}>
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="btn btn-ghost intake-pick" onClick={() => setPickerSlot(i)}>
                      📋 Pick intake item
                    </button>
                  )}
                  {sl.photoIds.length > 0 && (
                    <div className="thumbs">
                      {sl.photoIds.map((id, n) => {
                        const p = photoMap.get(id);
                        if (!p) return null;
                        return (
                          <div className="thumb" key={id}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={p.previewUrl} alt="" />
                            {n === 0 && <span className="cover-tag">COVER</span>}
                            <button type="button" aria-label="Remove photo" onClick={() => removePhoto(id)}>
                              ✕
                            </button>
                            {n < sl.photoIds.length - 1 && (
                              <button
                                type="button"
                                className="thumb-last"
                                aria-label="Move photo to the end"
                                title="Move to end (e.g. SKU sticker)"
                                onClick={() => movePhotoToEnd(i, id)}
                              >
                                ⤓
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {sl.photoIds.length > 0 && (
                    <p className={`post-hint${sl.photoIds.length > MAX_PUBLISH_PHOTOS ? " size-warning" : ""}`}>
                      {sl.photoIds.length} photo{sl.photoIds.length === 1 ? "" : "s"}
                      {sl.photoIds.length > MAX_PUBLISH_PHOTOS &&
                        ` — eBay takes ${MAX_PUBLISH_PHOTOS}; photos after #${MAX_PUBLISH_PHOTOS} will be left off`}
                    </p>
                  )}
                  <label className="item-slot-add">
                    {sl.photoIds.length ? "+ Add more photos" : "📸 Tap or drop this item's photos"}
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={(e) => {
                        void addFilesToSlot(i, e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
              ))}
            </div>

            {pickerSlot !== null && (
              <div className="picker-backdrop" role="dialog" aria-modal="true" onClick={() => setPickerSlot(null)}>
                <div className="picker" onClick={(e) => e.stopPropagation()}>
                  <div className="picker-head">
                    <strong>Item {pickerSlot + 1}</strong>
                    <button type="button" className="btn btn-ghost" onClick={() => setPickerSlot(null)}>
                      Close
                    </button>
                  </div>
                  <AwaitingList
                    compact
                    onPick={(item) => attachIntake(pickerSlot, item)}
                    excludeIds={slots.map((x) => x.intake?.tempId).filter(Boolean) as string[]}
                  />
                </div>
              </div>
            )}

            <div className="result-actions" style={{ borderTop: "none", paddingTop: 0 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void writeSlots()}
                disabled={filledSlots === 0}
              >
                ✍️ Write {filledSlots || ""} listing{filledSlots === 1 ? "" : "s"}
              </button>
            </div>

            <details className="bulk-sort">
              <summary>Or drop a whole batch and let the app sort it</summary>

            <div className="field bin-field">
              <label htmlFor="bin">
                Bin / SKU code{" "}
                <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>
                  (where these items are stored)
                </span>
              </label>
              <input
                id="bin"
                type="text"
                placeholder="e.g. K75"
                value={binPrefix}
                onChange={(e) => setBinPrefix(e.target.value)}
                autoCapitalize="characters"
              />
              <span className="field-hint">
                Each item gets {binPrefix ? `${binPrefix.trim()}-A, ${binPrefix.trim()}-B` : "A, B, C"}
                … in order, so you can find it in the bin later. If this bin
                already has listings on eBay, lettering continues where it left
                off. You can edit any SKU after sorting.
              </span>
            </div>

            <div
              className={`dropzone${dragging ? " dragging" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <span className="icon" aria-hidden="true">
                📸
              </span>
              <strong>Tap to choose photos, or drag them all here</strong>
              <span>
                Every item in the batch · up to {MAX_PHOTOS} photos · JPG, PNG,
                WebP
              </span>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => void addFiles(e.target.files)}
              />
            </div>

            {bulkPhotos.length > 0 && (
              <div className="thumbs" aria-label="Selected photos">
                {bulkPhotos.map((p) => (
                  <div className="thumb" key={p.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.previewUrl} alt="" />
                    <button
                      type="button"
                      aria-label="Remove photo"
                      onClick={() => removePhoto(p.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="result-actions" style={{ borderTop: "none", paddingTop: 0 }}>
              <ModelSelector />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={useAsOneItem}
                disabled={bulkPhotos.length === 0 || sorting}
              >
                1️⃣ These photos are one item
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={sort}
                disabled={bulkPhotos.length === 0 || sorting}
              >
                {sorting ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Sorting{" "}
                    {bulkPhotos.length} photos…
                  </>
                ) : (
                  <>🔀 Sort {bulkPhotos.length || ""} photos into items</>
                )}
              </button>
            </div>
            </details>

            {error && (
              <p className="note note-error" role="alert">
                {error}
              </p>
            )}
          </section>

          {sorting && (
            <section className="panel">
              <div className="loading-card">
                <span className="spinner" aria-hidden="true" />
                <span>
                  {sortProgress ??
                    "Grouping photos by item, then double-checking for mixed-up or split items. This takes a little while for big batches."}
                </span>
              </div>
            </section>
          )}
        </>
      )}

      {step === "review" && (
        <ReviewBoard
          groups={groups}
          orphanIds={orphanIds}
          photoById={photoById}
          onRename={rename}
          onRenameSku={renameSku}
          onMovePhoto={movePhoto}
          onReorderPhoto={reorderPhoto}
          onDeleteGroup={deleteGroup}
          onAddGroup={addGroup}
          onWriteAll={writeAll}
          onBack={() => setStep("upload")}
        />
      )}

      {step === "listings" && (
        <ListingsView
          groups={usableGroups}
          photoById={photoById}
          ebayConnected={ebayConnected}
          onEdit={editListing}
          onRetry={writeGroup}
          onPost={postGroup}
          onPostAll={postAll}
          onPublishAndPromote={publishAndPromoteGroup}
          onSchedule={scheduleGroup}
          onBack={() => setStep("review")}
        />
      )}

      <p className="footnote">
  Your photos are sent securely to sort and write listings, and are not
  stored. Listings are saved to eBay as drafts or scheduled.
      </p>
    </main>
  );
}