import { NextResponse } from "next/server";
import { SheetsConfigError } from "./google-sheets";

/** Turn an intake failure into a response the phone screen can show. */
export function intakeError(context: string, e: unknown): NextResponse {
  if (e instanceof SheetsConfigError) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
  }
  console.error(`[${context}]`, e);
  const msg =
    e instanceof Error && /^(Couldn't find|Tracker script error|The .* tab is full)/.test(e.message)
      ? e.message
      : null;
  return NextResponse.json(
    { ok: false, error: msg || "Couldn't reach the tracker sheet — please try again." },
    { status: msg ? 404 : 500 }
  );
}
