import { NextRequest, NextResponse } from "next/server";
import { getClient, parseModelJson, anthropicAuthError } from "@/lib/anthropic";
import { guardApiRequest, safeErrorResponse } from "@/lib/api-guard";
import { toImageBlock, type WireImage } from "@/lib/images";
import { resolveModel } from "@/lib/models";
import { IDENTIFY_PROMPT, type IdentifyResult } from "@/lib/intake-prompt";

export const maxDuration = 60;

// A quick ID, not a full listing — the faster model is plenty.
const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";

const clean = (s: unknown, max = 120) =>
  String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export async function POST(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: { image?: WireImage; model?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body." }, { status: 400 });
  }
  const block = toImageBlock(body.image);
  if (!block) {
    return NextResponse.json({ ok: false, error: "No readable photo." }, { status: 400 });
  }

  try {
    const resp = await getClient().messages.create({
      model: resolveModel(body.model, DEFAULT_MODEL),
      max_tokens: 400,
      messages: [{ role: "user", content: [block, { type: "text", text: IDENTIFY_PROMPT }] }],
    });
    const textBlock = resp.content.find((b) => b.type === "text");
    const raw = parseModelJson<IdentifyResult>(textBlock && textBlock.type === "text" ? textBlock.text : "");
    const result: IdentifyResult = {
      id_line: clean(raw.id_line, 80),
      brand: clean(raw.brand, 60),
      item_type: clean(raw.item_type, 60),
      gender: clean(raw.gender, 20),
      color: clean(raw.color, 40),
      size: clean(raw.size, 30),
      sold_search: clean(raw.sold_search),
      terapeak_search: clean(raw.terapeak_search),
    };
    if (!result.id_line) throw new Error("Empty ID line.");
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    const fatal = anthropicAuthError(e);
    if (fatal) return NextResponse.json({ ok: false, error: fatal.message }, { status: fatal.status });
    return safeErrorResponse("intake/identify", e, "Couldn't read that photo — type the ID line yourself or try again.");
  }
}
