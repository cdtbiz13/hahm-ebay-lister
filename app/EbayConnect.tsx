"use client";

import { useCallback, useEffect, useState } from "react";
import { apiPost } from "@/lib/api-client";

interface Status {
  configured: boolean;
  connected: boolean;
}

interface Policy {
  type: "shipping" | "payment" | "returns";
  id: string;
  name: string;
  pinned: boolean;
}

export function EbayConnect() {
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pasteValue, setPasteValue] = useState("");
  const [policies, setPolicies] = useState<Policy[] | null>(null);

  // Show which business policies exist and which one scheduling will use.
  const checkPolicies = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await apiPost("/api/ebay/policies", {});
      const data = (await r.json()) as { ok: boolean; policies?: Policy[]; error?: string };
      if (!data.ok && !data.policies?.length) throw new Error(data.error || "Couldn't read policies.");
      setPolicies(data.policies || []);
    } catch (e) {
      setNotice({ ok: false, msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/ebay/status", { cache: "no-store" });
      setStatus((await r.json()) as Status);
    } catch {
      setStatus({ configured: false, connected: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Surface the result of an OAuth round-trip (?ebay=connected|declined|error).
    const params = new URLSearchParams(window.location.search);
    const e = params.get("ebay");
    if (e === "connected") setNotice({ ok: true, msg: "eBay account connected!" });
    else if (e === "declined")
      setNotice({ ok: false, msg: "eBay connection was declined." });
    else if (e === "error")
      setNotice({ ok: false, msg: params.get("msg") || "eBay connection failed." });
    if (e) window.history.replaceState({}, "", window.location.pathname);
  }, [refresh]);

  const disconnect = async () => {
    setBusy(true);
    try {
      await apiPost("/api/ebay/disconnect", {});
      await refresh();
      setNotice({ ok: true, msg: "Disconnected from eBay." });
    } finally {
      setBusy(false);
    }
  };

  const startConnect = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await apiPost("/api/ebay/auth", {});
      const data = (await r.json()) as { ok: boolean; url?: string; error?: string };
      if (!data.ok || !data.url) throw new Error(data.error || "Couldn't start eBay authorization.");
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setNotice({ ok: false, msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const finishConnect = async () => {
    if (!pasteValue.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await apiPost("/api/ebay/connect", { url: pasteValue.trim() });
      const data = (await r.json()) as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error || "Couldn't connect.");
      setPasteValue("");
      await refresh();
      setNotice({ ok: true, msg: "eBay account connected!" });
    } catch (e) {
      setNotice({ ok: false, msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  // If eBay isn't configured on the server, show nothing (the writing flow
  // still works fine without it).
  if (!status?.configured) {
  return (
    <div className="ebay-bar">
      <span>eBay is not configured on this server.</span>
    </div>
  );
}
  return (
    <div className={`ebay-bar${status.connected ? " connected" : ""}`}>
      <span className="ebay-dot" aria-hidden="true" />
      {status.connected ? (
        <>
          <span className="ebay-label">eBay account connected</span>
          <button
            type="button"
            className="btn-ghost"
            onClick={checkPolicies}
            disabled={busy}
          >
            Business policies
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={disconnect}
            disabled={busy}
          >
            Disconnect
          </button>
          {policies && (
            <div className="ebay-policies">
              {policies.length === 0 ? (
                <p>No business policies found. Create them in eBay → Account → Business policies.</p>
              ) : (
                (["shipping", "payment", "returns"] as const).map((type) => (
                  <div key={type}>
                    <strong>{type[0].toUpperCase() + type.slice(1)}:</strong>{" "}
                    {policies
                      .filter((p) => p.type === type)
                      .map((p) => `${p.pinned ? "✅ " : ""}${p.name} (${p.id})`)
                      .join(" · ") || "none"}
                  </div>
                ))
              )}
              <p className="post-hint">
                ✅ = the one scheduling uses. To pick another, set EBAY_SHIPPING_POLICY,
                EBAY_PAYMENT_POLICY or EBAY_RETURN_POLICY in Vercel to its name or ID.
              </p>
            </div>
          )}
        </>
      ) : (
        <>
          <span className="ebay-label">
            <strong>Step 1:</strong> authorize on eBay
          </span>
          <button
            type="button"
            className="btn-ghost"
            onClick={startConnect}
            disabled={busy}
          >
            Open eBay ↗
          </button>
          <div className="ebay-paste">
            <label htmlFor="ebay-paste">
              <strong>Step 2:</strong> after you click <em>Agree</em>, copy the
              URL from eBay&rsquo;s page and paste it here:
            </label>
            <div className="ebay-paste-row">
              <input
                id="ebay-paste"
                type="text"
                placeholder="https://auth2.ebay.com/oauth2/…?code=…"
                value={pasteValue}
                onChange={(e) => setPasteValue(e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost"
                onClick={finishConnect}
                disabled={busy || !pasteValue.trim()}
              >
                {busy ? "Connecting…" : "Finish connecting"}
              </button>
            </div>
          </div>
        </>
      )}
      {notice && (
        <span className={`ebay-notice${notice.ok ? "" : " err"}`}>
          {notice.msg}
        </span>
      )}
    </div>
  );
}
