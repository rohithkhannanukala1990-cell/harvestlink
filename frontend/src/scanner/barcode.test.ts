/** Same cases as backend/tests/barcode.test.ts "barcode normalization" — the two copies must agree. */
import { describe, expect, it } from "vitest";
import {
  GS,
  expandUpcE,
  gtinCheckDigitValid,
  isValidGtin,
  lookupCandidates,
  normalizeBarcode,
  parseGs1,
} from "./barcode";

const UPC_A = "036000291452";
const GS1_GTIN = "09506000134352";

describe("barcode normalization (frontend copy)", () => {
  it("treats UPC-A, EAN-13 and GTIN-14 forms of one item as the same code", () => {
    expect(normalizeBarcode(UPC_A).code).toBe("00036000291452");
    expect(normalizeBarcode(`0${UPC_A}`).code).toBe("00036000291452");
    expect(normalizeBarcode(`00${UPC_A}`).code).toBe("00036000291452");
  });

  it("strips AIM prefixes and control characters, and undoes Caps Lock", () => {
    expect(normalizeBarcode(`]E0${UPC_A}\r\n`)).toEqual({ code: "00036000291452", symbology: "]E0" });
    expect(normalizeBarcode("  shelf-77\t").code).toBe("SHELF-77");
  });

  it("validates GS1 check digits, including UPC-E via its UPC-A expansion", () => {
    expect(gtinCheckDigitValid(UPC_A)).toBe(true);
    expect(gtinCheckDigitValid("036000291453")).toBe(false);
    expect(expandUpcE("04252614")).toBe("042100005264");
    expect(lookupCandidates("04252614")).toEqual(["04252614", "00042100005264"]);
    expect(isValidGtin("04252614")).toBe(true);
    expect(isValidGtin("96385074")).toBe(true);
    expect(isValidGtin("12345678")).toBe(false);
  });

  it("parses GS1 element strings in printed and scanned forms", () => {
    expect(parseGs1(`(01)${GS1_GTIN}(17)201225(10)ABC123`)).toMatchObject({
      gtin: GS1_GTIN,
      lot: "ABC123",
      expiry: "2020-12-25",
    });
    expect(parseGs1(`]C101${GS1_GTIN}10abc${GS}17260200`)).toMatchObject({
      gtin: GS1_GTIN,
      lot: "ABC",
      expiry: "2026-02-28",
    });
    expect(parseGs1(UPC_A)).toBeNull();
    expect(parseGs1("SHELF-77")).toBeNull();
    expect(parseGs1("0109506000134353")).toBeNull();
  });
});
