/**
 * Resolves a scan against a count sheet, entirely on the device, so counting works with no signal.
 * Same precedence as the server's lookupBarcode: lot label, GS1 (GTIN + lot), product barcode,
 * SKU, lot number. Only lines on this count can match — anything else is "not on this count".
 */
import type { StockCountSheet, StockCountSheetLine } from "../api/types";
import { lookupCandidates, normalizeBarcode, parseGs1 } from "./barcode";

export type CountScanResolution =
  | { kind: "line"; line: StockCountSheetLine }
  /** A product code matched a product with several lots on this count: the counter picks one. */
  | { kind: "choose-lot"; lines: StockCountSheetLine[] }
  | { kind: "not-on-count"; code: string };

function settle(lines: StockCountSheetLine[]): CountScanResolution | null {
  if (lines.length === 0) return null;
  if (lines.length === 1) return { kind: "line", line: lines[0]! };
  return { kind: "choose-lot", lines };
}

export function resolveCountScan(sheet: StockCountSheet, raw: string): CountScanResolution {
  const { code } = normalizeBarcode(raw);
  const candidates = new Set(lookupCandidates(code));
  const lines = sheet.lines;
  const sameText = (a: string | null) => a !== null && a.toUpperCase() === code;

  const byLotLabel = lines.filter((l) => l.lotBarcode !== null && candidates.has(l.lotBarcode));
  if (byLotLabel.length > 0) return settle(byLotLabel)!;

  const gs1 = parseGs1(raw);
  if (gs1?.gtin) {
    const gtin = normalizeBarcode(gs1.gtin).code;
    const ofProduct = lines.filter((l) => l.productBarcodes.includes(gtin));
    const lot = gs1.lot ? ofProduct.filter((l) => l.lotNumber?.toUpperCase() === gs1.lot) : [];
    const resolved = settle(lot.length > 0 ? lot : ofProduct);
    if (resolved) return resolved;
  }

  const byProductCode = lines.filter((l) => l.productBarcodes.some((c) => candidates.has(c)));
  const bySku = lines.filter((l) => sameText(l.sku));
  const resolved = settle(byProductCode.length > 0 ? byProductCode : bySku);
  if (resolved) return resolved;

  return settle(lines.filter((l) => sameText(l.lotNumber))) ?? { kind: "not-on-count", code };
}
