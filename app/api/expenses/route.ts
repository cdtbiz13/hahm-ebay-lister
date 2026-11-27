import { NextRequest, NextResponse } from "next/server";
import { guardApiRequest } from "@/lib/api-guard";
import {
  addExpense,
  addMiles,
  deleteTrip,
  expenseTypes,
  listTrips,
  recentExpenses,
  recentMiles,
  saveTrip,
} from "@/lib/expenses";
import { isIsoDate } from "@/lib/intake";
import { intakeError } from "@/lib/intake-route";

export const maxDuration = 60;

type Body = {
  action?: string;
  item?: string;
  type?: string;
  amount?: number;
  date?: string;
  description?: string;
  purpose?: string;
  miles?: number;
  saveAsTrip?: boolean;
  name?: string;
};

const bad = (error: string) => NextResponse.json({ ok: false, error }, { status: 400 });

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let b: Body;
  try {
    b = await req.json();
  } catch {
    return bad("Invalid request body.");
  }

  try {
    switch (b.action) {
      case "load": {
        const [types, trips, expenses, miles] = await Promise.all([
          expenseTypes(),
          listTrips(),
          recentExpenses(),
          recentMiles(),
        ]);
        return NextResponse.json({ ok: true, types, trips, expenses, miles });
      }

      case "addExpense": {
        const item = String(b.item ?? "").trim();
        const amount = Number(b.amount);
        if (!item) return bad("What was it?");
        if (!(amount > 0 && amount < 100000)) return bad("Enter the amount.");
        if (!isIsoDate(b.date)) return bad("Pick a date.");
        const row = await addExpense({ item, type: String(b.type ?? ""), amount, date: b.date });
        return NextResponse.json({ ok: true, row });
      }

      case "addMiles": {
        const description = String(b.description ?? "").trim();
        const miles = Number(b.miles);
        if (!description) return bad("Where did you go?");
        if (!(miles > 0 && miles < 5000)) return bad("Enter the miles.");
        if (!isIsoDate(b.date)) return bad("Pick a date.");
        const purpose = String(b.purpose ?? "").trim();
        const row = await addMiles({ date: b.date, description, purpose, miles });
        if (b.saveAsTrip) await saveTrip({ name: description, miles, purpose });
        return NextResponse.json({ ok: true, row });
      }

      case "deleteTrip": {
        if (!String(b.name ?? "").trim()) return bad("Missing trip.");
        await deleteTrip(String(b.name));
        return NextResponse.json({ ok: true });
      }

      default:
        return bad("Unknown action.");
    }
  } catch (e) {
    return intakeError("expenses", e);
  }
}
