"use client";

import { useCallback, useEffect, useState } from "react";
import { apiPost } from "@/lib/api-client";
import { todayLocalIso } from "@/lib/intake-client";
import { AppNav } from "../AppNav";

interface Trip {
  name: string;
  miles: number;
  purpose: string;
}
interface ExpenseRow {
  item: string;
  type: string;
  amount: number;
  date: string;
}
interface KeptItem {
  row: number;
  id: string;
  description: string;
  cost: number;
  date: string;
}
interface MilesRow {
  date: string;
  description: string;
  purpose: string;
  miles: number;
}

const PURPOSES = ["Sourcing", "Shipping / post office", "Supplies run", "Other business"];
const money = (n: number) => `$${n.toFixed(2)}`;

async function call(body: Record<string, unknown>) {
  const res = await apiPost("/api/expenses", body);
  const data = await res.json().catch(() => ({ ok: false, error: `Request failed (${res.status}).` }));
  if (!data.ok) throw new Error(data.error || "Couldn't reach the tracker.");
  return data;
}

export default function ExpensesPage() {
  const [types, setTypes] = useState<string[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [miles, setMiles] = useState<MilesRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kept, setKept] = useState<{ items: KeptItem[]; total: number }>({ items: [], total: 0 });
  const [kBusy, setKBusy] = useState(false);
  const [kNote, setKNote] = useState<string | null>(null);

  // Expense form
  const [eDate, setEDate] = useState("");
  const [item, setItem] = useState("");
  const [type, setType] = useState("");
  const [amount, setAmount] = useState("");
  const [eBusy, setEBusy] = useState(false);
  const [eNote, setENote] = useState<{ ok: boolean; msg: string } | null>(null);

  // Mileage form
  const [mDate, setMDate] = useState("");
  const [desc, setDesc] = useState("");
  const [purpose, setPurpose] = useState(PURPOSES[0]);
  const [mi, setMi] = useState("");
  const [saveTrip, setSaveTrip] = useState(false);
  const [mBusy, setMBusy] = useState(false);
  const [mNote, setMNote] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const d = await call({ action: "load" });
      setTypes(d.types);
      setTrips(d.trips);
      setExpenses(d.expenses);
      setMiles(d.miles);
      setKept(d.kept ?? { items: [], total: 0 });
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    const today = todayLocalIso();
    setEDate(today);
    setMDate(today);
    void load();
  }, [load]);

  const submitExpense = async () => {
    setEBusy(true);
    setENote(null);
    try {
      await call({ action: "addExpense", item, type, amount: parseFloat(amount), date: eDate });
      setENote({ ok: true, msg: `Saved: ${item} · ${money(parseFloat(amount))}` });
      setItem("");
      setAmount("");
      void load();
    } catch (e) {
      setENote({ ok: false, msg: (e as Error).message });
    } finally {
      setEBusy(false);
    }
  };

  const submitMiles = async () => {
    setMBusy(true);
    setMNote(null);
    const isSaved = trips.some((t) => t.name.toLowerCase() === desc.trim().toLowerCase());
    try {
      await call({
        action: "addMiles",
        date: mDate,
        description: desc,
        purpose,
        miles: parseFloat(mi),
        saveAsTrip: saveTrip && !isSaved,
      });
      setMNote({ ok: true, msg: `Logged: ${desc} · ${parseFloat(mi)} mi` });
      setDesc("");
      setMi("");
      setSaveTrip(false);
      void load();
    } catch (e) {
      setMNote({ ok: false, msg: (e as Error).message });
    } finally {
      setMBusy(false);
    }
  };

  const markPaid = async () => {
    if (!window.confirm(`Mark ${kept.items.length} kept item(s) as paid ($${kept.total.toFixed(2)})? Only do this after the transfer.`)) return;
    setKBusy(true);
    setKNote(null);
    try {
      const d = await call({ action: "markKeptPaid" });
      setKNote(`Marked ${d.count} item(s) paid — $${Number(d.total).toFixed(2)}.`);
      void load();
    } catch (e) {
      setKNote((e as Error).message);
    } finally {
      setKBusy(false);
    }
  };

  const removeTrip = async (name: string) => {
    try {
      await call({ action: "deleteTrip", name });
      setTrips((prev) => prev.filter((t) => t.name !== name));
    } catch (e) {
      setMNote({ ok: false, msg: (e as Error).message });
    }
  };

  const useTrip = (t: Trip) => {
    setDesc(t.name);
    setMi(String(t.miles));
    if (t.purpose) setPurpose(t.purpose);
    setMNote(null);
  };

  const expenseReady = item.trim() && parseFloat(amount) > 0 && eDate;
  const milesReady = desc.trim() && parseFloat(mi) > 0 && mDate;
  const knownTrip = trips.some((t) => t.name.toLowerCase() === desc.trim().toLowerCase());

  return (
    <main className="wrap intake">
      <header className="masthead">
        <span className="logo-mark" aria-hidden="true">💵</span>
        <div>
          <h1>Expenses &amp; miles</h1>
          <p>Log it once — it lands in the right tab of your tracker.</p>
        </div>
      </header>
      <AppNav current="/expenses" />

      {loadError && <p className="note note-error">{loadError}</p>}

      <section className="panel">
        <h2 className="section-label">🚗 Miles driven</h2>
        {trips.length > 0 && (
          <div className="trip-chips">
            {trips.map((t) => (
              <span key={t.name} className={`trip-chip${desc === t.name ? " active" : ""}`}>
                <button type="button" onClick={() => useTrip(t)}>
                  {t.name} · {t.miles} mi
                </button>
                <button type="button" aria-label={`Forget ${t.name}`} className="trip-x" onClick={() => void removeTrip(t.name)}>
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="intake-settings">
          <label className="field">
            <span>Date</span>
            <input type="date" value={mDate} onChange={(e) => setMDate(e.target.value)} />
          </label>
          <label className="field">
            <span>Where</span>
            <input value={desc} placeholder="TH Goodwill, Mattoon yard sales…" onChange={(e) => setDesc(e.target.value)} />
          </label>
          <label className="field">
            <span>Purpose</span>
            <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              {PURPOSES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Miles (round trip)</span>
            <input inputMode="decimal" value={mi} placeholder="0" onChange={(e) => setMi(e.target.value.replace(/[^0-9.]/g, ""))} />
          </label>
        </div>
        <div className="result-actions">
          {!knownTrip && (
            <label className="check">
              <input type="checkbox" checked={saveTrip} onChange={(e) => setSaveTrip(e.target.checked)} />
              Save as a regular trip
            </label>
          )}
          <button type="button" className="btn btn-primary" disabled={!milesReady || mBusy} onClick={() => void submitMiles()}>
            {mBusy ? "Saving…" : "Log miles"}
          </button>
        </div>
        {mNote && <p className={`note${mNote.ok ? "" : " note-error"}`}>{mNote.msg}</p>}
        {miles.length > 0 && (
          <details className="recent">
            <summary>Recent trips in the tracker</summary>
            <ul>
              {miles.map((m, i) => (
                <li key={i}>
                  {m.date || "—"} · {m.description} · {m.miles} mi
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="panel">
        <h2 className="section-label">🏠 Kept items</h2>
        <p className="kept-total">
          Transfer to resale account: <strong>{money(kept.total)}</strong>
        </p>
        {kept.items.length > 0 ? (
          <>
            <ul className="kept-list">
              {kept.items.map((k) => (
                <li key={k.row}>
                  <span>
                    {k.id && <strong>{k.id}</strong>} {k.description}
                    {k.date && <span className="post-hint"> · kept {k.date}</span>}
                  </span>
                  <span>{money(k.cost)}</span>
                </li>
              ))}
            </ul>
            <div className="result-actions">
              <span className="post-hint">Move this from main checking to the resale account, then tap:</span>
              <button type="button" className="btn btn-primary" disabled={kBusy} onClick={() => void markPaid()}>
                {kBusy ? "Saving…" : "I transferred it"}
              </button>
            </div>
          </>
        ) : (
          <p className="post-hint">Nothing owed. Items you mark Kept in Intake show up here.</p>
        )}
        {kNote && <p className="note">{kNote}</p>}
      </section>

      <section className="panel">
        <h2 className="section-label">🧾 Business expense</h2>
        <div className="intake-settings">
          <label className="field">
            <span>Date</span>
            <input type="date" value={eDate} onChange={(e) => setEDate(e.target.value)} />
          </label>
          <label className="field">
            <span>What was it?</span>
            <input value={item} placeholder="Poly mailers, Flyp, PO box…" onChange={(e) => setItem(e.target.value)} />
          </label>
          <label className="field">
            <span>Type</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Pick a type…</option>
              {types.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Amount</span>
            <input inputMode="decimal" value={amount} placeholder="0.00" onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
          </label>
        </div>
        <div className="result-actions">
          <button type="button" className="btn btn-primary" disabled={!expenseReady || eBusy} onClick={() => void submitExpense()}>
            {eBusy ? "Saving…" : "Save expense"}
          </button>
        </div>
        {eNote && <p className={`note${eNote.ok ? "" : " note-error"}`}>{eNote.msg}</p>}
        {expenses.length > 0 && (
          <details className="recent">
            <summary>Recent expenses in the tracker</summary>
            <ul>
              {expenses.map((x, i) => (
                <li key={i}>
                  {x.date || "—"} · {x.item} · {money(x.amount)}
                  {x.type && <> · {x.type}</>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </main>
  );
}
