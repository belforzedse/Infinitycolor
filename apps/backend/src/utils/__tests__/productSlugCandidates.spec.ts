import {
  buildProductSlugCandidates,
  encodeSlugLower,
  foldArabicToPersian,
  safeDecodeSlug,
} from "../productSlugCandidates";

describe("buildProductSlugCandidates", () => {
  const adelina = "کت-آدلینا-w00238";
  const storedAdelina = encodeSlugLower(adelina);

  it("covers the live W00238 Persian slug regression in both directions", () => {
    expect(buildProductSlugCandidates(adelina)).toContain(storedAdelina);
    expect(buildProductSlugCandidates(storedAdelina)).toContain(adelina);
  });

  it("handles a double-encoded inbound slug", () => {
    expect(buildProductSlugCandidates(encodeURIComponent(storedAdelina))).toContain(adelina);
  });

  it("folds Arabic yeh and kaf without removing ZWNJ", () => {
    const arabicVariant = "كیف\u200cمردانه";
    const candidates = buildProductSlugCandidates(arabicVariant);

    expect(candidates).toContain(foldArabicToPersian(arabicVariant.normalize("NFC")));
    expect(candidates.some((candidate) => candidate.includes("\u200c"))).toBe(true);
  });

  it("leaves malformed encoding safe and deduplicates candidates", () => {
    expect(safeDecodeSlug("%E0%A4%A")).toBe("%E0%A4%A");
    const candidates = buildProductSlugCandidates("simple-slug");
    expect(candidates).toEqual([...new Set(candidates)]);
  });
});
