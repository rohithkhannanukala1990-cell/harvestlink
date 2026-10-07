/**
 * Online barcode lookup (GET /barcodes/lookup). Returns no quantities, so it is safe mid-count.
 * The counting screen resolves against its cached count instead, so it keeps working offline.
 */
import { apiRequest } from "../api/client";
import type { Gs1Data } from "./barcode";

export type BarcodeMatch = {
  matchedBy: "LOT_BARCODE" | "GS1" | "PRODUCT_BARCODE" | "SKU" | "LOT_NUMBER";
  product: { id: string; sku: string; name: string; category: string };
  lot: { id: string; lotNumber: string; expiryDate: string | null; status: string } | null;
};

export type BarcodeLookupResult = {
  raw: string;
  code: string;
  gs1: Gs1Data | null;
  matches: BarcodeMatch[];
};

export function lookupBarcode(storeId: string | null, code: string): Promise<BarcodeLookupResult> {
  const params = new URLSearchParams({ code });
  if (storeId) params.set("storeId", storeId);
  return apiRequest<BarcodeLookupResult>(`/barcodes/lookup?${params.toString()}`);
}
