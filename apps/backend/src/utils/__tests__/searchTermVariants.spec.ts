import { expandSearchTermVariants } from "../searchTermVariants";

describe("expandSearchTermVariants", () => {
  it("matches a spaced product code when the shopper types it unspaced", () => {
    expect(expandSearchTermVariants("w00288")).toEqual(["w00288", "w 00288"]);
    expect(expandSearchTermVariants("G0024")).toEqual(["G0024", "G 0024"]);
  });

  it("matches an unspaced product code when the shopper types the stored spelling", () => {
    expect(expandSearchTermVariants("W 00288")).toEqual(["W 00288", "W00288"]);
  });

  it("collapses stray separators between the prefix and the digits", () => {
    expect(expandSearchTermVariants("W  00288")).toEqual(["W  00288", "W 00288", "W00288"]);
    expect(expandSearchTermVariants("W\u200c00288")).toEqual([
      "W\u200c00288",
      "W 00288",
      "W00288",
    ]);
  });

  it("accepts Persian and Arabic-Indic digits", () => {
    expect(expandSearchTermVariants("W۰۰۲۸۸")).toEqual([
      "W۰۰۲۸۸",
      "W00288",
      "W 00288",
    ]);
    expect(expandSearchTermVariants("W٠٠٢٨٨")).toEqual([
      "W٠٠٢٨٨",
      "W00288",
      "W 00288",
    ]);
  });

  it("finds a code embedded in a longer query", () => {
    expect(expandSearchTermVariants("بامبر w00288")).toEqual(["بامبر w00288", "بامبر w 00288"]);
  });

  it("leaves terms without a letter/digit boundary untouched", () => {
    expect(expandSearchTermVariants("شلوار جین")).toEqual(["شلوار جین"]);
    expect(expandSearchTermVariants("XL")).toEqual(["XL"]);
    expect(expandSearchTermVariants("38")).toEqual(["38"]);
  });

  it("trims the term and treats blank input as no search", () => {
    expect(expandSearchTermVariants("  w00288  ")).toEqual(["w00288", "w 00288"]);
    expect(expandSearchTermVariants("   ")).toEqual([]);
    expect(expandSearchTermVariants("")).toEqual([]);
    expect(expandSearchTermVariants(undefined)).toEqual([]);
    expect(expandSearchTermVariants(null)).toEqual([]);
    expect(expandSearchTermVariants(42)).toEqual([]);
  });
});
