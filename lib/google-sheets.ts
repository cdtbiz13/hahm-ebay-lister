// Minimal Google Sheets client for the intake feature.
//
// Uses a Google Cloud *service account* (a robot login that only sees sheets
// you share with it). No extra npm packages: we sign the OAuth JWT with Node's
// built-in crypto and call the Sheets REST API with fetch.
//
// Env vars (set in Vercel → Settings → Environment Variables):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL  e.g. intake-bot@my-project.iam.gserviceaccount.com
//   GOOGLE_PRIVATE_KEY            the "private_key" value from the JSON key file
//   TRACKER_SPREADSHEET_ID        the ID from the tracker's URL
//   TRACKER_TAB                   optional, defaults to "2026"

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

export function sheetsConfig() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  // Vercel stores multi-line values fine, but people often paste the key with
  // literal "\n" sequences from the JSON file — normalize both forms.
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  const spreadsheetId = process.env.TRACKER_SPREADSHEET_ID?.trim();
  const tab = process.env.TRACKER_TAB?.trim() || "2026";
  if (!email || !key || !spreadsheetId) {
    throw new SheetsConfigError(
      "Intake isn't set up yet: add GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY and TRACKER_SPREADSHEET_ID in Vercel → Settings → Environment Variables, then redeploy."
    );
  }
  return { email, key, spreadsheetId, tab };
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
  await call(`/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
}

export async function listTabs(): Promise<{ title: string; sheetId: number }[]> {
  const data = await call<{ sheets?: { properties: { title: string; sheetId: number } }[] }>(
    `?fields=sheets.properties(title,sheetId)`
  );
  return (data.sheets ?? []).map((s) => s.properties);
}

/** Create a hidden tab with a header row (used for the app's intake list). */
export async function addHiddenTab(title: string, header: string[]): Promise<void> {
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
