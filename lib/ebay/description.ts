// Turns the plain-text listing description (the seller's template) into simple
// HTML for eBay. eBay renders descriptions as HTML, so plain line breaks would
// collapse into one block of text; this keeps the template readable on phones:
// a bold first line, bold section headings, bullet lists, short paragraphs.
// No styles, scripts, links or images (eBay strips or penalises them).

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const HEADING = /^(DETAILS|MEASUREMENTS|CONDITION|FEATURES|INCLUDED|DIMENSIONS|NOTES)\b.*$/;
const BULLET = /^\s*[•\-*·]\s+/;

export function descriptionToHtml(text: string | undefined): string {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (/<[a-z][\s\S]*>/i.test(raw)) return raw; // already HTML — leave it

  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${li}</li>`).join("")}</ul>`);
    list = [];
  };

  lines.forEach((line, i) => {
    if (!line) {
      flush();
      return;
    }
    const safe = escapeHtml(line);
    if (BULLET.test(line)) {
      list.push(escapeHtml(line.replace(BULLET, "")));
    } else if (i === 0) {
      flush();
      out.push(`<p><b>${safe}</b></p>`);
    } else if (HEADING.test(line)) {
      flush();
      out.push(`<p><b>${safe}</b></p>`);
    } else {
      flush();
      out.push(`<p>${safe}</p>`);
    }
  });
  flush();
  return out.join("\n");
}
