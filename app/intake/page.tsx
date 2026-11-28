"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiPost } from "@/lib/api-client";
import { makeIntakeThumb, resizeImage } from "@/lib/resize";
import {
  TAX_SOURCES,
  costWithTax,
  floorFor,
  loadBatch,
  loadSettings,
  soldCompsUrl,
  storeBatch,
  storeSettings,
  terapeakUrl,
  todayLocalIso,
  type IntakeDraft,
} from "@/lib/intake-client";
import { AwaitingList } from "../AwaitingList";
import { AppNav } from "../AppNav";

const IDENTIFY_CONCURRENCY = 3;
const MAX_BATCH = 40;

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k-${Date.now()}-${Math.random()}`;
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(text.trim().slice(0, 140) || `Request failed (${res.status}).`);
  }
}

const money = (n: number) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : "—");

export default function IntakePage() {
  const [date, setDate] = useState("");
  const [sourceId, setSourceId] = useState("terre-haute");
  const [taxIncluded, setTaxIncluded] = useState(false);
  const [drafts, setDrafts] = useState<IntakeDraft[]>([]);
  const [bundleTotal, setBundleTotal] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [awaitingKey, setAwaitingKey] = useState(0);
  const loaded = useRef(false);
  const queue = useRef<{ key: string; file: File }[]>([]);
  const running = useRef(0);

  // Restore an unsaved batch + the last tax source on this device.
  useEffect(() => {
    setDate(todayLocalIso()); // set on the device, so it's the local day
    const s = loadSettings();
    setSourceId(s.sourceId);
    setTaxIncluded(s.taxIncluded);
    setDrafts(loadBatch());
    loaded.current = true;
  }, []);
  useEffect(() => {
    if (loaded.current) storeBatch(drafts);
  }, [drafts]);
  useEffect(() => {
    if (loaded.current) storeSettings({ sourceId, taxIncluded });
  }, [sourceId, taxIncluded]);

  const rate = TAX_SOURCES.find((t) => t.id === sourceId)?.rate ?? 0;

  const patch = (key: string, p: Partial<IntakeDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...p } : d)));

  const shelfOf = (d: IntakeDraft) =>
    d.bundle ? d.bundle.total / d.bundle.count : parseFloat(d.shelfPrice);
  const costOf = (d: IntakeDraft) => costWithTax(shelfOf(d), rate, taxIncluded);

  // ── Read each photo with Claude, a few at a time ─────────
  const pump = useCallback(() => {
    while (running.current < IDENTIFY_CONCURRENCY && queue.current.length > 0) {
      const job = queue.current.shift()!;
      running.current++;
      (async () => {
        try {
          const img = await resizeImage(job.file);
          const res = await apiPost("/api/intake/identify", {
            image: { mediaType: img.mediaType, data: img.data },
          });
          const data = await readJson(res);
          if (!data.ok) throw new Error(data.error || "Couldn't read that photo.");
          const r = data.result;
          patch(job.key, {
            status: "ready",
            idLine: r.id_line,
            size: r.size || "",
            soldSearch: r.sold_search || "",
            terapeakSearch: r.terapeak_search || "",
          });
        } catch (e) {
          patch(job.key, { status: "error", error: (e as Error).message });
        } finally {
          running.current--;
          pump();
        }
      })();
    }
  }, []);

  const addPhotos = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setNotice(null);
    const list = Array.from(files).filter((f) => f.type.startsWith("image/") || f.name.match(/\.(heic|heif)$/i));
    const room = MAX_BATCH - drafts.length;
    if (room <= 0) {
      setNotice({ ok: false, msg: `Save this batch first — ${MAX_BATCH} items max per batch.` });
      return;
    }
    for (const file of list.slice(0, room)) {
      const key = newKey();
      let thumb = "";
      try {
        thumb = await makeIntakeThumb(file);
      } catch {
        /* thumbnail is a nice-to-have */
      }
      setDrafts((prev) => [
        ...prev,
        { key, thumb, status: "reading", idLine: "", size: "", soldSearch: "", terapeakSearch: "", shelfPrice: "" },
      ]);
      queue.current.push({ key, file });
      pump();
    }
  };

  // ── Bundles ─────────────────────────────────────────────
  const selected = drafts.filter((d) => d.selected);
  const applyBundle = () => {
    const total = parseFloat(bundleTotal);
    if (!(total >= 0) || selected.length < 2) return;
    const count = selected.length;
    setDrafts((prev) =>
      prev.map((d) =>
        d.selected ? { ...d, bundle: { total, count }, shelfPrice: "", selected: false } : d
      )
    );
    setBundleTotal("");
  };

  // ── Save ────────────────────────────────────────────────
  const problems = useMemo(() => {
    const out: string[] = [];
    drafts.forEach((d, i) => {
      if (d.status === "reading") out.push(`Item ${i + 1} is still being read`);
      else if (!d.idLine.trim()) out.push(`Item ${i + 1} needs an ID line`);
      if (!Number.isFinite(costOf(d))) out.push(`Item ${i + 1} needs a price`);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, rate, taxIncluded]);

  const save = async () => {
    if (drafts.length === 0 || problems.length > 0) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await apiPost("/api/intake/save", {
        items: drafts.map((d) => ({
          idLine: d.idLine.trim(),
          size: d.size.trim(),
          cost: costOf(d),
          datePurchased: date || todayLocalIso(),
          soldSearch: d.soldSearch,
          terapeakSearch: d.terapeakSearch,
          thumb: d.thumb,
        })),
      });
      const data = await readJson(res);
      if (!data.ok) throw new Error(data.error || "Couldn't save to the tracker.");
      const ids: string[] = data.tempIds;
      setNotice({
        ok: true,
        msg: `Saved ${ids.length} item${ids.length === 1 ? "" : "s"} to the tracker: ${ids[0]}${
          ids.length > 1 ? ` – ${ids[ids.length - 1]}` : ""
        }`,
      });
      setDrafts([]);
      setAwaitingKey((k) => k + 1);
    } catch (e) {
      setNotice({ ok: false, msg: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const batchTotal = drafts.reduce((s, d) => s + (Number.isFinite(costOf(d)) ? costOf(d) : 0), 0);

  return (
    <main className="wrap intake">
      <header className="masthead">
        <span className="logo-mark" aria-hidden="true">📥</span>
        <div>
          <h1>Intake</h1>
          <p>Photo + price for each new find → tracker row with a temp ID.</p>
        </div>
      </header>
      <AppNav current="/intake" />

      <section className="panel">
        <h2 className="section-label">1 · This haul</h2>
        <div className="intake-settings">
          <label className="field">
            <span>Date bought</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value || todayLocalIso())} />
          </label>
          <label className="field">
            <span>Where from</span>
            <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {TAX_SOURCES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </label>
          {rate > 0 && (
            <label className="check">
              <input type="checkbox" checked={taxIncluded} onChange={(e) => setTaxIncluded(e.target.checked)} />
              Prices I type already include tax
            </label>
          )}
        </div>
      </section>

      <section className="panel">
        <h2 className="section-label">2 · Items ({drafts.length})</h2>

        <label className="dropzone intake-add">
          <span className="icon" aria-hidden="true">📸</span>
          <strong>Take photo</strong>
          <span>One photo per item — tap again for the next one</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              void addPhotos(e.target.files);
              e.target.value = "";
            }}
          />
        </label>

        <div className="intake-list">
          {drafts.map((d, i) => {
            const cost = costOf(d);
            const floor = floorFor(cost);
            return (
              <div className={`intake-card${d.selected ? " selected" : ""}`} key={d.key}>
                <div className="intake-thumb">
                  {d.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={d.thumb} alt="" />
                  ) : (
                    <span>#{i + 1}</span>
                  )}
                </div>
                <div className="intake-body">
                  {d.status === "reading" ? (
                    <p className="post-hint"><span className="spinner" aria-hidden="true" /> Reading photo…</p>
                  ) : (
                    <>
                      <input
                        className="intake-idline"
                        value={d.idLine}
                        placeholder="Brand + item + gender + color + size"
                        onChange={(e) => patch(d.key, { idLine: e.target.value, status: "ready" })}
                      />
                      {d.status === "error" && <p className="note note-error">{d.error}</p>}
                      {d.idLine.includes("[SIZE]") && (
                        <p className="post-hint size-warning">Size not visible — replace [SIZE] or leave it.</p>
                      )}
                    </>
                  )}

                  <div className="intake-row">
                    {d.bundle ? (
                      <span className="chip">
                        Bundle {money(d.bundle.total)} ÷ {d.bundle.count}
                        <button type="button" aria-label="Undo bundle" onClick={() => patch(d.key, { bundle: undefined })}>✕</button>
                      </span>
                    ) : (
                      <label className="price-input">
                        $
                        <input
                          inputMode="decimal"
                          placeholder="Price"
                          value={d.shelfPrice}
                          onChange={(e) => patch(d.key, { shelfPrice: e.target.value.replace(/[^0-9.]/g, "") })}
                        />
                      </label>
                    )}
                    <span className="intake-cost">
                      Cost {money(cost)}
                      {Number.isFinite(floor) && <> · Min <strong>{money(floor)}</strong></>}
                    </span>
                  </div>

                  <div className="intake-row intake-actions">
                    {d.soldSearch && (
                      <a href={soldCompsUrl(d.soldSearch)} target="_blank" rel="noreferrer">Sold comps ↗</a>
                    )}
                    {d.terapeakSearch && (
                      <a href={terapeakUrl(d.terapeakSearch)} target="_blank" rel="noreferrer">Terapeak ↗</a>
                    )}
                    {!d.bundle && (
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={Boolean(d.selected)}
                          onChange={(e) => patch(d.key, { selected: e.target.checked })}
                        />
                        Bundle
                      </label>
                    )}
                    <button
                      type="button"
                      className="link-danger"
                      onClick={() => setDrafts((prev) => prev.filter((x) => x.key !== d.key))}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {selected.length >= 2 && (
          <div className="bundle-bar">
            <span>{selected.length} items bought together for</span>
            <label className="price-input">
              $
              <input inputMode="decimal" placeholder="Total" value={bundleTotal} onChange={(e) => setBundleTotal(e.target.value.replace(/[^0-9.]/g, ""))} />
            </label>
            <button type="button" className="btn btn-ghost" onClick={applyBundle} disabled={!(parseFloat(bundleTotal) >= 0)}>
              Split it
            </button>
          </div>
        )}
        {selected.length === 1 && <p className="post-hint">Check at least one more item to split a bundle price.</p>}

        {drafts.length > 0 && (
          <div className="result-actions intake-save">
            <span className="post-hint">
              {drafts.length} item{drafts.length === 1 ? "" : "s"} · {money(batchTotal)} total cost
              {problems.length > 0 && <> · {problems[0]}</>}
            </span>
            <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving || problems.length > 0}>
              {saving ? <><span className="spinner" aria-hidden="true" /> Saving…</> : <>💾 Save {drafts.length} to tracker</>}
            </button>
          </div>
        )}

        {notice && (
          <p className={`note${notice.ok ? "" : " note-error"}`} role="status">{notice.msg}</p>
        )}
      </section>

      <AwaitingList refreshKey={awaitingKey} />
    </main>
  );
}

