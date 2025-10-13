// src/config/googleSheets.js
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

/**
 * Google Sheets helper
 *
 * - Supports two modes:
 *   1) GOOGLE_APPLICATION_CREDENTIALS points to a service account JSON file (local dev).
 *   2) GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY env vars (recommended for Render).
 *
 * - Exports:
 *   - getRawValues()
 *   - getRowsAsObjects()
 *   - appendRow()
 *
 * Notes:
 *  - On Render (or other hosts) store the private key with `\n` escaped (lines replaced by `\n`)
 *    and this module will convert it back to real newlines:
 *      GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIE...==\n-----END PRIVATE KEY-----\n"
 *
 *  - Ensure SHEET_ID contains only the spreadsheetId (not full URL).
 */

const SHEET_ID = process.env.SHEET_ID || process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "Sheet1";

if (!SHEET_ID) {
  // Do not throw at module-load time so imports don't crash tests — functions will guard.
  console.warn(
    "⚠️ googleSheets: SHEET_ID / SPREADSHEET_ID env var is not set."
  );
}

/**
 * Create an authenticated sheets client.
 * Chooses method depending on available env vars.
 */
function createSheetsClient() {
  // If user provided a credentials JSON file path (local dev), use GoogleAuth with keyFile
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyFile) {
    const auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    return google.sheets({ version: "v4", auth });
  }

  // Otherwise use service-account fields from env (recommended for Render)
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY || "";

  if (!clientEmail || !privateKey) {
    // We'll allow creation but later functions will check and throw a clear error.
    // Log a warning to help debugging.
    console.warn(
      "⚠️ googleSheets: GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY not set. Sheets calls will fail until configured."
    );
  }

  // When private key is stored in env make sure we convert escaped newlines to real ones
  if (privateKey) {
    privateKey = privateKey.replace(/\\n/g, "\n").replace(/\r/g, "").trim();
  }

  // Basic shape check (does it look like a PEM block?)
  const looksLikePem =
    /^-----BEGIN PRIVATE KEY-----\n[\s\S]+?\n-----END PRIVATE KEY-----\n?$/.test(
      privateKey
    );

  if (!looksLikePem) {
    console.error(
      "googleSheets: private key PEM format invalid. Check GOOGLE_PRIVATE_KEY env (must contain '-----BEGIN PRIVATE KEY-----' and escaped \\n)."
    );
    // throw or return a meaningful error so your handler doesn't fail with OpenSSL nonsense
    throw new Error(
      "Server misconfigured: invalid Google private key format (GOOGLE_PRIVATE_KEY)."
    );
  }

  // Optional small safe debug: show first/last 30 chars (masked) so you can confirm formatting without exposing secret
  const start = privateKey.slice(0, 30).replace(/[^-A-Za-z0-9]/g, "");
  const end = privateKey.slice(-30).replace(/[^-A-Za-z0-9]/g, "");
  console.log(
    `googleSheets: privateKey preview start="${start}..." end="...${end}"`
  );

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

const sheets = createSheetsClient();

/** Internal guard to ensure sheet id and auth are configured */
function ensureConfig() {
  if (!SHEET_ID) {
    const err = new Error(
      "Server misconfigured: missing SHEET_ID / SPREADSHEET_ID environment variable."
    );
    err.code = "MISSING_SHEET_ID";
    throw err;
  }

  const hasAuthFile = !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const hasEnvCreds = !!(
    process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY
  );

  if (!hasAuthFile && !hasEnvCreds) {
    const err = new Error(
      "Server misconfigured: missing Google service account credentials. " +
        "Set GOOGLE_APPLICATION_CREDENTIALS (local file) or GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY (env)."
    );
    err.code = "MISSING_GOOGLE_CREDS";
    throw err;
  }

  // optional: check that sheets object seems valid
  if (!sheets || !sheets.spreadsheets) {
    const err = new Error("Google Sheets client not initialized correctly.");
    err.code = "SHEETS_CLIENT_ERROR";
    throw err;
  }
}

/**
 * Return raw values (2D array) from A:Z
 */
export async function getRawValues() {
  ensureConfig();

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:Z`,
    });
    return res.data.values || [];
  } catch (err) {
    console.error("googleSheets.getRawValues error:", err.message || err);
    // rethrow so caller can handle (and logs contain a useful message)
    throw err;
  }
}

/**
 * Return array of objects, mapped by header row.
 * Example: [{ id: '123', date: '2025-10-08', ... }, ...]
 */
export async function getRowsAsObjects() {
  const values = await getRawValues();
  if (!values.length) return [];
  const header = values[0].map((h) => (h ? String(h).trim() : ""));
  const rows = values.slice(1).map((row) => {
    const obj = {};
    header.forEach((colName, i) => {
      obj[colName || `col${i}`] = row[i] ?? "";
    });
    return obj;
  });
  return rows;
}

/**
 * Append a single row (array of values) to the sheet.
 * rowArray must be an array of primitives matching the header order.
 */
export async function appendRow(rowArray) {
  ensureConfig();

  if (!Array.isArray(rowArray)) {
    throw new Error("appendRow expects an array of values.");
  }

  try {
    const res = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:Z`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [rowArray] },
    });

    // You can optionally return res.data for caller if needed
    return res.data;
  } catch (err) {
    console.error(
      "googleSheets.appendRow error:",
      err.errors || err.message || err
    );
    throw err;
  }
}
