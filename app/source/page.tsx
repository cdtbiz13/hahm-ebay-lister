"use client";

import { useEffect, useRef, useState } from "react";
import { apiPost } from "@/lib/api-client";
import { makeIntakeThumb, resizeImage } from "@/lib/resize";
import {
  TAX_SOURCES,
  checkBuy,
  loadBatch,
  loadMultiplier,
  loadSettings,
  soldCompsUrl,
  storeBatch,
  storeMultiplier,
  storeSettings,
  terapeakUrl,
} from "@/lib/intake-client";
import { AppNav } from "../AppNav";

const money = (n: number) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : "—");
const num = (s: string) => parseFloat(s);

interface Found {
  thumb: string;
  idLine: string;
  size: string;
  soldSearch: string;
  terapeakSearch: string;
}

const EMPTY: Found = { thumb: "", idLine: "", size: "", soldSearch: "", terapeakSearch: "" };

export default function SourcePage() {
  const [sourceId, setSourceId] = useState("terre-haute");
  const [taxIncluded, setTaxIncluded] = useState(false);
  const [multiplier, setMultiplier] = useState("3.5");
  const [found, setFound] = useState<Found>(EMPTY);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  // Used only for the verdict — never saved or carried into intake/listing.
  const [listPrice, setListPrice] = useState("");
  const [shelf, setShelf] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [boughtCount, setBoughtCount] = useState(0);
  const loaded = useRef(false);

  useEffect(() => {
    const s = loadSettings();
    setSourceId(s.sourceId);
    setTaxIncluded(s.taxIncluded);
    setMultiplier(String(loadMultiplier()));
    setBoughtCount(loadBatch().length);
    loaded.current = true;
  }, []);
  useEffect(() => {
    if (loaded.current) storeSettings({ sourceId, taxIncluded });
  }, [sourceId, taxIncluded]);
  useEffect(() => {
    const n = num(multiplier);
    if (loaded.current && n >= 1 && n <= 20) storeMultiplier(n);
  }, [multiplier]);

  const rate = TAX_SOURCES.find((t) => t.id === sourceId)?.rate ?? 0;
  const mult = num(multiplier) >= 1 ? num(multiplier) : 3.5;
  const check = checkBuy(num(listPrice), num(shelf), rate, taxIncluded, mult);

  const reset = () => {
    setFound(EMPTY);
    setListPrice("");
    setShelf("");
    setReadError(null);
  };

  const onPhoto = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    reset();
    setReading(true);
    try {
      const [thumb, img] = await Promise.all([
        makeIntakeThumb(file).catch(() => ""),
        resizeImage(file),
      ]);
      setFound((f) => ({ ...f, thumb }));
      const res = await apiPost("/api/intake/identify", {
        image: { mediaType: img.mediaType, data: img.data },
      });
      const data = await res.json().catch(() => ({ ok: false, error: `Request failed (${res.status}).` }));
      if (!data.ok) throw new Error(data.error || "Couldn't read that photo.");
      const r = data.result;
      setFound({
        thumb,
        idLine: r.id_line,
        size: r.size || "",
        soldSearch: r.sold_search || r.id_line,
        terapeakSearch: r.terapeak_search || r.id_line,
      });
    } catch (e) {
      setReadError(`${(e as Error).message} You can type the search words below instead.`);
    } finally {
      setReading(false);
    }
  };

  // Send to this device's Intake batch. The planned list price stays behind on purpose.
  const boughtIt = () => {
    const batch = loadBatch();
    const idLine = found.idLine || found.soldSearch || "New item";
    batch.push({
      key: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}`,
      thumb: found.thumb,
      status: "ready",
      idLine,
      size: found.size,
      soldSearch: found.soldSearch,
      terapeakSearch: found.terapeakSearch,
      shelfPrice: shelf,
    });
    storeBatch(batch);
    setBoughtCount(batch.length);
    setToast(`Added to Intake (${batch.length} waiting): ${idLine}`);
    reset();
  };

  const verdictText = check
    ? check.verdict === "good"
      ? "✅ Good buy"
      : check.verdict === "thin"
        ? `⚠️ Thin — covers your minimum, but under your ${mult}× rule`
        : "❌ Pass — a 10% offer or sale would put it under your minimum"
    : null;

  return (
    <main className="wrap intake">
      <header className="masthead">
        <span className="logo-mark" aria-hidden="true">🔎</span>
        <div>
          <h1>Sourcing check</h1>
          <p>Photo → comps → your list price → buy or pass.</p>
        </div>
      </header>
      <AppNav current="/source" />

      <section className="panel">
        <div className="intake-settings">
          <label className="field">
            <span>Where</span>
            <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {TAX_SOURCES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Buy rule (× cost)</span>
            <input inputMode="decimal" value={multiplier} onChange={(e) => setMultiplier(e.target.value.replace(/[^0-9.]/g, ""))} />
          </label>
          {rate > 0 && (
            <label className="check">
              <input type="checkbox" checked={taxIncluded} onChange={(e) => setTaxIncluded(e.target.checked)} />
              Tag prices include tax
            </label>
          )}
        </div>
      </section>

      <section className="panel">
        <h2 className="section-label">1 · What is it?</h2>
        <div className="source-top">
          <label className="dropzone source-photo">
            {found.thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={found.thumb} alt="" />
            ) : (
              <>
                <span className="icon" aria-hidden="true">📸</span>
                <strong>Snap the item</strong>
              </>
            )}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => {
                void onPhoto(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
          <div className="intake-body">
            {reading && <p className="post-hint"><span className="spinner" aria-hidden="true" /> Reading photo…</p>}
            {found.idLine && <p className="awaiting-idline">{found.idLine}</p>}
            {readError && <p className="note note-error">{readError}</p>}
            <label className="field source-search">
              <span>Sold search</span>
              <input value={found.soldSearch} placeholder="Brand item size gender Pre-Owned" onChange={(e) => setFound((f) => ({ ...f, soldSearch: e.target.value }))} />
            </label>
            <label className="field source-search">
              <span>Terapeak search</span>
              <input value={found.terapeakSearch} placeholder="Brand item size gender" onChange={(e) => setFound((f) => ({ ...f, terapeakSearch: e.target.value }))} />
            </label>
          </div>
        </div>
        <div className="source-links">
          <a className={`btn btn-ghost${found.soldSearch ? "" : " disabled"}`} href={found.soldSearch ? soldCompsUrl(found.soldSearch) : undefined} target="_blank" rel="noreferrer">
            Sold comps ↗
          </a>
          <a className={`btn btn-ghost${found.terapeakSearch ? "" : " disabled"}`} href={found.terapeakSearch ? terapeakUrl(found.terapeakSearch) : undefined} target="_blank" rel="noreferrer">
            Terapeak ↗
          </a>
        </div>
      </section>

      <section className="panel">
        <h2 className="section-label">2 · Worth it?</h2>
        <div className="source-prices">
          <label className="field">
            <span>I&rsquo;d list it for</span>
            <span className="price-input">$<input inputMode="decimal" value={listPrice} placeholder="0.00" onChange={(e) => setListPrice(e.target.value.replace(/[^0-9.]/g, ""))} /></span>
          </label>
          <label className="field">
            <span>Tag price</span>
            <span className="price-input">$<input inputMode="decimal" value={shelf} placeholder="0.00" onChange={(e) => setShelf(e.target.value.replace(/[^0-9.]/g, ""))} /></span>
          </label>
        </div>

        {check && (
          <div className={`verdict verdict-${check.verdict}`} role="status">
            <strong>{verdictText}</strong>
            <span>
              List {money(num(listPrice))} · cost {money(check.cost)}
              {Number.isFinite(check.multiple) && <> · {check.multiple.toFixed(1)}× cost</>}
            </span>
            <span>
              Profit {money(check.profit)} · <strong>Your pay {money(check.pay)}</strong> (55%) — after eBay fees, before shipping
            </span>
            <span>
              List at least {money(check.passLine)} so a 10% offer or sale still clears your minimum ({money(check.floor)}).
            </span>
            <span>
              Most to pay at this list price: <strong>{money(check.maxShelf)}</strong>
              {!taxIncluded && rate > 0 && " tag price"}
            </span>
          </div>
        )}
        {!check && num(listPrice) > 0 && (
          <p className="post-hint">Enter the tag price to see the verdict.</p>
        )}

        <div className="result-actions source-actions">
          <button type="button" className="btn btn-ghost" onClick={reset}>
            Pass / next item
          </button>
          <button type="button" className="btn btn-primary" onClick={boughtIt} disabled={!(found.idLine || found.soldSearch) || !(num(shelf) >= 0)}>
            🛒 Bought it
          </button>
        </div>
        <p className="post-hint">
          Bought it sends the photo, ID and tag price to Intake on this device ({boughtCount} waiting).
          The list price you typed here is not saved — you&rsquo;ll set the real one when listing.
        </p>
        {toast && <p className="note" role="status">{toast}</p>}
      </section>
    </main>
  );
}
