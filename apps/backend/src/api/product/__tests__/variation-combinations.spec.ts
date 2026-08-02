import {
  buildVariationCombinations,
  normalizeVariationAxes,
  signatureFromVariation,
} from "../services/variation-combinations";

describe("variation combination generation", () => {
  it("builds deterministic Cartesian combinations across legacy and generic axes", () => {
    const axes = normalizeVariationAxes([
      { type: "color", termIds: [8, 7, 8] },
      { type: "attribute", attributeId: 31, termIds: [102, 101] },
    ]);

    expect(buildVariationCombinations(axes)).toEqual([
      {
        signature: "attribute:31=102|color=8",
        colorId: 8,
        attributeTermIds: [102],
      },
      {
        signature: "attribute:31=101|color=8",
        colorId: 8,
        attributeTermIds: [101],
      },
      {
        signature: "attribute:31=102|color=7",
        colorId: 7,
        attributeTermIds: [102],
      },
      {
        signature: "attribute:31=101|color=7",
        colorId: 7,
        attributeTermIds: [101],
      },
    ]);
  });

  it("reconstructs signatures for existing variations without a stored signature", () => {
    expect(
      signatureFromVariation({
        product_variation_color: { id: 7 },
        product_variation_size: { id: 12 },
        selected_attribute_terms: [
          { id: 102, product_attribute: { id: 31 } },
          { id: 205, product_attribute: { id: 40 } },
        ],
      }),
    ).toBe("attribute:31=102|attribute:40=205|color=7|size=12");
  });

  it("rejects duplicate axes and requests over the safety cap", () => {
    expect(() =>
      normalizeVariationAxes([
        { type: "attribute", attributeId: 31, termIds: [1] },
        { type: "attribute", attributeId: 31, termIds: [2] },
      ]),
    ).toThrow("Duplicate variation attribute");

    expect(() =>
      normalizeVariationAxes([
        { type: "color", termIds: Array.from({ length: 100 }, (_, index) => index + 1) },
        { type: "size", termIds: Array.from({ length: 51 }, (_, index) => index + 1) },
      ]),
    ).toThrow("limited to 5000 combinations");
  });
});
