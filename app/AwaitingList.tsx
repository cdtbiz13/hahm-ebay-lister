"use client";

import { useCallback, useEffect, useState } from "react";
import { apiPost } from "@/lib/api-client";
import { floorFor, soldCompsUrl, terapeakUrl, type AwaitingItem } from "@/lib/intake-client";

const REASONS = ["Donated", "Damaged", "Keeping", "Other"] as const;

const money = (n: number) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : "—");

/**
 * Items saved at intake that haven't been listed yet.
 * - On the Intake screen: browse them and remove ones that won't be listed.
 * - On the Listing screen (onPick set): tap one to attach it to an item box.
 */
export function AwaitingList({
  refreshKey = 0,
  onPick,
  excludeIds = [],
  compact = false,
}: {
  refreshKey?: number;
  onPick?: (item: AwaitingItem) => void;
  excludeIds?: string[];
  compact?: boolean;
}) {
  const [items, setItems] = useState<AwaitingItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiPost("/api/intake/list", {});
      const data = await res.json().catch(() => ({ ok: false, error: `Request failed (${res.status}).` }));
      if (!data.ok) throw new Error(data.error || "Couldn't load the intake list.");
      setItems(data.items as AwaitingItem[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const remove = async (tempId: string, reason: string) => {
    setRemoving(tempId);
    setError(null);
    try {
      const res = await apiPost("/api/intake/remove", { tempId, reason });
      const data = await res.json().catch(() => ({ ok: false }));
      if (!data.ok) throw new Error(data.error || "Couldn't remove it.");
      setItems((prev) => (prev ?? []).filter((i) => i.tempId !== tempId));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRemoving(null);
    }
  };

  const q = query.trim().toLowerCase();
  const visible = (items ?? [])
    .filter((i) => !excludeIds.includes(i.tempId))
    .filter((i) => !q || `${i.tempId} ${i.idLine}`.toLowerCase().includes(q));

  return (
    <section className={compact ? "awaiting compact" : "panel awaiting"}>
      <div className="awaiting-head">
        <h2 className="section-label">
          {onPick ? "Pick the item you're listing" : "Awaiting photos"}
          {items && ` (${visible.length})`}
        </h2>
        <button type="button" className="btn btn-ghost" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "↻ Refresh"}
        </button>
      </div>
      {items && items.length > 6 && (
        <input
          className="awaiting-search"
          placeholder="Search temp ID or description"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {error && <p className="note note-error">{error}</p>}
      {items && visible.length === 0 && !error && (
        <p className="post-hint">Nothing waiting — everything from intake has been listed.</p>
      )}

      <div className="awaiting-grid">
        {visible.map((it) => (
          <div className="awaiting-card" key={it.tempId}>
            <div className="intake-thumb">
              {it.thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={it.thumb} alt="" />
              ) : (
                <span>📦</span>
              )}
            </div>
            <div className="intake-body">
              <strong className="sku-tag">{it.tempId}</strong>
              <p className="awaiting-idline">{it.idLine}</p>
              <p className="post-hint">
                Cost {money(it.cost)} · Min {money(floorFor(it.cost))} · {it.datePurchased}
              </p>
              <div className="intake-row intake-actions">
                {onPick ? (
                  <button type="button" className="btn btn-primary" onClick={() => onPick(it)}>
                    Use this item
                  </button>
                ) : (
                  <>
                    {it.soldSearch && (
                      <a href={soldCompsUrl(it.soldSearch)} target="_blank" rel="noreferrer">Sold comps ↗</a>
                    )}
                    {it.terapeakSearch && (
                      <a href={terapeakUrl(it.terapeakSearch)} target="_blank" rel="noreferrer">Terapeak ↗</a>
                    )}
                    <select
                      className="remove-select"
                      value=""
                      disabled={removing === it.tempId}
                      onChange={(e) => {
                        const reason = e.target.value;
                        if (reason && window.confirm(
                          reason === "Donated" || reason === "Damaged"
                            ? `Remove ${it.tempId} as ${reason}? Its tracker row is set to Donate with $0 sold.`
                            : `Remove ${it.tempId} (${reason})? It leaves this list; its tracker row is not changed.`
                        )) {
                          void remove(it.tempId, reason);
                        }
                      }}
                    >
                      <option value="">{removing === it.tempId ? "Removing…" : "Remove…"}</option>
                      {REASONS.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
