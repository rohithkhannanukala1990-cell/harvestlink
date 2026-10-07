/**
 * Barcode normalization and GS1 parsing — a copy of backend/src/lib/barcode.ts.
 *
 * The counting screen resolves scans against the count it has cached, so it works with no signal;
 * that only holds if a code normalizes here exactly as the server stored it. Change both files
 * together; the tests on each side use the same cases.
 *
 * What arrives from a keyboard-wedge scanner is not always what is printed:
 * - An AIM symbology prefix ("]E0", "]C1") when the scanner is configured to send one.
 * - Swapped letter case when Caps Lock is on (the scanner "types" Shift+letter), so codes are
 *   compared upper-cased.
 * - The same item as UPC-A (12 digits) or EAN-13 (13, leading 0) or GTIN-14 depending on scanner
 *   settings, so numeric GTINs are zero-padded to 14 digits.
 * - UPC-E (8 digits) or its UPC-A expansion, again depending on settings; see lookupCandidates.
 */

/** ASCII group separator: GS1 FNC1 between variable-length fields. */
export const GS = "\u001d";

const AIM_PREFIX = /^\][A-Za-z][0-9A-Za-z]/;
/**
 * AIM identifiers that mean "this is a GS1 element string": GS1-128 ]C1, DataBar ]e0, DataMatrix
 * ]d2, QR ]Q3. Compared upper-cased because Caps Lock flips them too; that also matches EAN-13's
 * ]E0, which is harmless — 13 digits never parse as a complete element string.
 */
const GS1_SYMBOLOGIES = new Set(["]C1", "]E0", "]D2", "]Q3"]);

export type NormalizedBarcode = {
  /** Canonical form used for storage and lookup. */
  code: string;
  /** AIM symbology identifier when the scanner sent one, e.g. "]C1" (GS1-128). */
  symbology: string | null;
};

export function normalizeBarcode(raw: string): NormalizedBarcode {
  let s = raw.trim();
  let symbology: string | null = null;
  const aim = AIM_PREFIX.exec(s);
  if (aim) {
    symbology = aim[0];
    s = s.slice(aim[0].length);
  }
  // Drop control characters except GS, which separates GS1 fields.
  // oxlint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001c\u001e\u001f\u007f]/g, "").trim().toUpperCase();
  if (/^\d+$/.test(s) && (s.length === 12 || s.length === 13 || s.length === 14)) {
    s = s.padStart(14, "0");
  }
  return { code: s, symbology };
}

/** GS1 mod-10 check: digits weighted 3,1,3,1… from the right, excluding the check digit. */
export function gtinCheckDigitValid(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 8) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/** UPC-E (8 digits incl. number system and check digit) → UPC-A (12 digits), or null if not UPC-E. */
export function expandUpcE(code: string): string | null {
  if (!/^[01]\d{7}$/.test(code)) return null;
  const ns = code[0];
  const d = code.slice(1, 7);
  const check = code[7];
  const last = d[5];
  let body: string;
  if (last === "0" || last === "1" || last === "2") {
    body = `${d[0]}${d[1]}${last}0000${d[2]}${d[3]}${d[4]}`;
  } else if (last === "3") {
    body = `${d[0]}${d[1]}${d[2]}00000${d[3]}${d[4]}`;
  } else if (last === "4") {
    body = `${d[0]}${d[1]}${d[2]}${d[3]}00000${d[4]}`;
  } else {
    body = `${d[0]}${d[1]}${d[2]}${d[3]}${d[4]}0000${last}`;
  }
  const upcA = `${ns}${body}${check}`;
  return gtinCheckDigitValid(upcA) ? upcA : null;
}

/** True when `code` (already normalized) is a GTIN with a valid check digit. */
export function isValidGtin(code: string): boolean {
  if (!/^\d+$/.test(code)) return false;
  if (code.length === 14) return gtinCheckDigitValid(code);
  if (code.length === 8) return gtinCheckDigitValid(code) || expandUpcE(code) !== null;
  return false;
}

/**
 * Codes to try when looking a scan up. An 8-digit scan may be EAN-8 (stored as scanned) or UPC-E
 * (the product may be registered under its UPC-A expansion), so both are tried.
 */
export function lookupCandidates(code: string): string[] {
  const out = [code];
  if (code.length === 8) {
    const upcA = expandUpcE(code);
    if (upcA) out.push(upcA.padStart(14, "0"));
  }
  return out;
}

export type Gs1Data = {
  /** GTIN-14 from AI (01) or (02). */
  gtin: string | null;
  /** Batch / lot from AI (10). */
  lot: string | null;
  /** Expiry from AI (17), as YYYY-MM-DD. */
  expiry: string | null;
  /** Best-before from AI (15), as YYYY-MM-DD. */
  bestBefore: string | null;
  serial: string | null;
};

const FIXED_AI_LENGTH: Record<string, number> = {
  "00": 18,
  "01": 14,
  "02": 14,
  "11": 6,
  "13": 6,
  "15": 6,
  "16": 6,
  "17": 6,
};
const VARIABLE_AI_MAX: Record<string, number> = { "10": 20, "21": 20, "30": 8, "37": 8 };

/** GS1 YYMMDD → YYYY-MM-DD. Day "00" means the last day of the month. */
function gs1Date(yymmdd: string): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const year = 2000 + Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  let day = Number(yymmdd.slice(4, 6));
  if (month < 1 || month > 12) return null;
  if (day === 0) day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1) return null;
  return d.toISOString().slice(0, 10);
}

function toGs1Data(fields: Map<string, string>): Gs1Data | null {
  const gtin = fields.get("01") ?? fields.get("02") ?? null;
  if (gtin !== null && !gtinCheckDigitValid(gtin)) return null;
  const data: Gs1Data = {
    gtin,
    lot: fields.get("10") ?? null,
    expiry: fields.has("17") ? gs1Date(fields.get("17")!) : null,
    bestBefore: fields.has("15") ? gs1Date(fields.get("15")!) : null,
    serial: fields.get("21") ?? null,
  };
  return data.gtin || data.lot ? data : null;
}

/**
 * Parses a GS1 element string: "(01)…(10)…" as printed, or the raw form a scanner sends, where
 * variable-length fields end at GS or at the end of the data.
 *
 * Returns null for anything that is not clearly GS1, so a plain internal code is never misread.
 * Raw data must start with a known AI and, for (01), carry a valid GTIN check digit. A wedge that
 * drops GS characters makes a variable field swallow everything after it; putting (10) last on
 * printed labels (the usual layout) avoids that.
 */
export function parseGs1(raw: string): Gs1Data | null {
  const { code, symbology } = normalizeBarcode(raw);

  if (code.startsWith("(")) {
    const fields = new Map<string, string>();
    const re = /\((\d{2,4})\)([^(]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) fields.set(m[1]!, m[2]!.replace(new RegExp(GS, "g"), ""));
    return fields.size > 0 ? toGs1Data(fields) : null;
  }

  const declaredGs1 =
    (symbology !== null && GS1_SYMBOLOGIES.has(symbology.toUpperCase())) || code.includes(GS);
  const looksGs1 = /^(01|02)\d{14}/.test(code) && code.length >= 16;
  if (!declaredGs1 && !looksGs1) return null;

  const fields = new Map<string, string>();
  let i = 0;
  while (i < code.length) {
    if (code[i] === GS) {
      i += 1;
      continue;
    }
    const ai = code.slice(i, i + 2);
    const fixed = FIXED_AI_LENGTH[ai];
    if (fixed !== undefined) {
      const value = code.slice(i + 2, i + 2 + fixed);
      if (value.length !== fixed || !/^\d+$/.test(value)) return null;
      fields.set(ai, value);
      i += 2 + fixed;
      continue;
    }
    const max = VARIABLE_AI_MAX[ai];
    if (max === undefined) break;
    let end = code.indexOf(GS, i + 2);
    if (end === -1) end = code.length;
    fields.set(ai, code.slice(i + 2, Math.min(end, i + 2 + max)));
    i = end;
  }
  return fields.size > 0 ? toGs1Data(fields) : null;
}
