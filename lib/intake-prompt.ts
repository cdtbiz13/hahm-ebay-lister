// Prompt for the intake step: one quick photo → a short ID line for the
// tracker plus the two Rule Set A research strings. Not a full listing — the
// real title is written later from the listing photos.

export interface IdentifyResult {
  id_line: string;
  brand?: string;
  item_type?: string;
  gender?: string;
  color?: string;
  size?: string;
  sold_search?: string;
  terapeak_search?: string;
}

export const IDENTIFY_PROMPT = `You are helping a reseller log a thrift-store item they just bought. From the photo, write a short ID line so they can recognize this exact item later and match it to their inventory tracker.

ID LINE FORMAT: Brand + Item Type + Gender + Color + Size
• Examples: "Madewell Skinny Jeans Womens Dark Wash 30", "Coach Signature Crossbody Bag Brown", "Corning Ware Cranberry Casserole Dish 1.5L"
• Gender (Womens, Mens, Unisex, Boys, Girls, Kids) only for clothing, shoes and accessories that have one. Skip it for home goods, tools, media, etc.
• Color is important — it's how two similar items get told apart. Use the main color or wash.
• Size: only if you can read it in the photo. If the item is sized (clothing, shoes) but the size isn't visible, write [SIZE] in its place. Never guess a size.
• Brand: only if you can read it or it's unmistakable. If unknown, start with the item type.
• Keep it under 60 characters. No condition words, no hype, no punctuation beyond what's needed.

SEARCH STRINGS (the seller's Rule Set A — never mix the two):
• sold_search (tight, for eBay sold listings): Brand + Model/Style + Item Type + Size + Gender. NO condition word (no Pre-Owned, Used, NWT, New) — the sold-search link already filters by condition.
• terapeak_search (broad, for Terapeak): Brand + Core Item + Size + Gender only. No color, condition or minor descriptors.
• Leave out size or gender if not visible or not applicable — never guess, and never put [SIZE] in a search string.

Return ONLY valid JSON, no markdown:
{"id_line": "...", "brand": "...", "item_type": "...", "gender": "...", "color": "...", "size": "...", "sold_search": "...", "terapeak_search": "..."}
Use "" for any field you can't tell from the photo.`;
