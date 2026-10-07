import { describe, expect, it } from "vitest";
import type { StockCountSheet, StockCountSheetLine } from "../api/types";
import { parseQuantityEntry } from "./quantityEntry";
import { resolveCountScan } from "./resolveCountScan";

describe("parseQuantityEntry", () => {
  it("sums parts and rejects anything that is not whole numbers", () => {
    expect(parseQuantityEntry("12")).toBe(12);
    expect(parseQuantityEntry("12+6 + 3")).toBe(21);
    expect(parseQuantityEntry("0")).toBe(0);
    for (const bad of ["", "+", "12+", "-3", "1.5", "abc", "99999999"]) {
      expect(parseQuantityEntry(bad)).toBeNull();
    }
  });
});

function line(id: string, patch: Partial<StockCountSheetLine>): StockCountSheetLine {
  return {
    id,
    productId: `p-${id}`,
    sku: `SKU-${id}`,
    productName: `Product ${id}`,
    lotId: `lot-${id}`,
    lotNumber: `LOT-${id}`,
    expiryDate: null,
    productBarcodes: [],
    lotBarcode: null,
    status: "PENDING",
    countedByYou: false,
    recountByAnotherPerson: false,
    ...patch,
  };
}

const sheet: StockCountSheet = {
  id: "c1",
  storeId: "s1",
  type: "CYCLE",
  status: "IN_PROGRESS",
  scheduledFor: null,
  startedAt: null,
  completedAt: null,
  notes: null,
  lines: [
    line("beans-a", { productId: "beans", sku: "BEANS", lotNumber: "B-1", productBarcodes: ["00036000291452"] }),
    line("beans-b", { productId: "beans", sku: "BEANS", lotNumber: "B-2", productBarcodes: ["00036000291452"], lotBarcode: "CRATE-9" }),
    line("oil", { productId: "oil", sku: "OIL", lotNumber: "ABC123", productBarcodes: ["09506000134352"] }),
    line("tea", { productId: "tea", sku: "TEA-1", productBarcodes: ["00042100005264"] }),
  ],
};

describe("resolveCountScan", () => {
  it("goes straight to the lot for a lot label", () => {
    expect(resolveCountScan(sheet, "crate-9")).toMatchObject({ kind: "line", line: { id: "beans-b" } });
  });

  it("asks which lot when a product code matches several lots on the count", () => {
    const r = resolveCountScan(sheet, "0036000291452");
    expect(r.kind).toBe("choose-lot");
    if (r.kind === "choose-lot") expect(r.lines.map((l) => l.id)).toEqual(["beans-a", "beans-b"]);
  });

  it("uses the GS1 lot to pick the lot", () => {
    expect(resolveCountScan(sheet, "(01)09506000134352(10)abc123")).toMatchObject({ line: { id: "oil" } });
  });

  it("matches UPC-E to a product registered under its UPC-A, and falls back to SKU and lot number", () => {
    expect(resolveCountScan(sheet, "04252614")).toMatchObject({ line: { id: "tea" } });
    expect(resolveCountScan(sheet, "tea-1")).toMatchObject({ line: { id: "tea" } });
    expect(resolveCountScan(sheet, "b-1")).toMatchObject({ line: { id: "beans-a" } });
  });

  it("reports codes that are not on this count", () => {
    expect(resolveCountScan(sheet, "4006381333931")).toEqual({ kind: "not-on-count", code: "04006381333931" });
  });
});
