// Minimal Google Sheets client for the intake feature. Two ways to connect:
//
// 1. Tracker script (simplest — see scripts/tracker-bridge.gs):
//      TRACKER_SCRIPT_URL     the Apps Script web app URL (…/exec)
//      TRACKER_SCRIPT_SECRET  the password set at the top of that script
// 2. Google Cloud service account:
//      GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, TRACKER_SPREADSHEET_ID
//
// Either way, TRACKER_TAB (optional) names this year's tab; defaults to "2026".
// No extra npm packages: the service-account JWT is signed with Node's crypto.

import crypto from "crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

export class SheetsConfigError extends Error {}

let cached: { token: string; exp: number } | null = null;

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** The year tab that holds inventory rows. */
export function trackerTab(): string {
  return process.env.TRACKER_TAB?.trim() || "2026";
}

function scriptConfig(): { url: string; secret: string } | null {
  const url = process.env.TRACKER_SCRIPT_URL?.trim();
  const secret = process.env.TRACKER_SCRIPT_SECRET?.trim();
  return url && secret ? { url, secret } : null;
}

// Talk to the Apps Script bound to the tracker. It answers JSON
// { ok, result | error }. Google redirects the POST once; fetch follows it.
async function scriptCall<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
  const cfg = scriptConfig()!;
  let res: Response;
  try {
    res = await fetch(cfg.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secret: cfg.secret, op, ...args }),
      redirect: "follow",
      cache: "no-store",
    });
  } catch {
    throw new Error("Couldn't reach the tracker script.");
  }
  const text = await res.text();
  let data: { ok?: boolean; result?: T; error?: string };
  try {
    data = JSON.parse(text);
  } catch {
    throw new SheetsConfigError(
      "The tracker script didn't answer correctly. In Apps Script, check the deployment is a Web app that runs as you with access set to Anyone, and that TRACKER_SCRIPT_URL ends in /exec."
    );
  }
  if (!data.ok) {
    if (data.error === "unauthorized") {
      throw new SheetsConfigError(
        "The tracker script rejected the password. TRACKER_SCRIPT_SECRET in Vercel must match SECRET at the top of the script."
      );
    }
    throw new Error(`Tracker script error: ${data.error || "unknown"}`);
  }
  return data.result as T;
}

export function sheetsConfig() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  // Vercel stores multi-line values fine, but people often paste the key with
  // literal "\n" sequences from the JSON file — normalize both forms.
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  const spreadsheetId = process.env.TRACKER_SPREADSHEET_ID?.trim();
  if (!email || !key || !spreadsheetId) {
    throw new SheetsConfigError(
      "Intake isn't connected to the tracker yet: add TRACKER_SCRIPT_URL and TRACKER_SCRIPT_SECRET in Vercel → Settings → Environment Variables, then redeploy."
    );
  }
  return { email, key, spreadsheetId };
}

async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;

  const { email, key } = sheetsConfig();
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })
  );
  const unsigned = `${header}.${claims}`;
  let signature: string;
  try {
    signature = b64url(crypto.createSign("RSA-SHA256").update(unsigned).sign(key));
  } catch {
    throw new SheetsConfigError(
      "GOOGLE_PRIVATE_KEY couldn't be read. Paste the whole private_key value from the JSON file, including the BEGIN/END lines."
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new SheetsConfigError(
      `Google sign-in failed (${data.error_description || res.status}). Check the service account email and key.`
    );
  }
  cached = { token: data.access_token, exp: now + (data.expires_in ?? 3600) };
  return data.access_token;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { spreadsheetId } = sheetsConfig();
  const token = await accessToken();
  const res = await fetch(`${API}/${spreadsheetId}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 403 || res.status === 404) {
      throw new SheetsConfigError(
        "The app can't open the tracker. Share the tracker sheet with the service account email (Editor), and check TRACKER_SPREADSHEET_ID."
      );
    }
    throw new Error(`Google Sheets error ${res.status}: ${text.slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** Quote a tab name for A1 notation ('2026'!A1). */
export function a1(tab: string, range: string): string {
  return `'${tab.replace(/'/g, "''")}'!${range}`;
}

export async function getValues(range: string): Promise<string[][]> {
  if (scriptConfig()) return scriptCall<string[][]>("get", { range });
  const data = await call<{ values?: string[][] }>(
    `/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`
  );
  return data.values ?? [];
}

/** Write several ranges at once. USER_ENTERED so dates and $ amounts parse like typing. */
export async function batchUpdateValues(
  data: { range: string; values: (string | number)[][] }[]
): Promise<void> {
  if (data.length === 0) return;
  if (scriptConfig()) {
    await scriptCall("update", { data });
    return;
  }
  await call(`/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
}

export async function listTabs(): Promise<{ title: string; sheetId: number }[]> {
  if (scriptConfig()) return scriptCall("tabs");
  const data = await call<{ sheets?: { properties: { title: string; sheetId: number } }[] }>(
    `?fields=sheets.properties(title,sheetId)`
  );
  return (data.sheets ?? []).map((s) => s.properties);
}

/** Create a hidden tab with a header row (used for the app's intake list). */
export async function addHiddenTab(title: string, header: string[]): Promise<void> {
  if (scriptConfig()) {
    await scriptCall("addHiddenTab", { title, header });
    return;
  }
  await call(`:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [
        {
          addSheet: {
            properties: {
              title,
              hidden: true,
              gridProperties: { rowCount: 2000, columnCount: header.length },
            },
          },
        },
      ],
    }),
  });
  await batchUpdateValues([{ range: a1(title, "A1"), values: [header] }]);
}
