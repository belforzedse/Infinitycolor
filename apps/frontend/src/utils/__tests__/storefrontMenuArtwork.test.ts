import { getStorefrontMenuArtwork } from "../storefrontMenuArtwork";

describe("getStorefrontMenuArtwork", () => {
  it("maps only the approved storefront menu artwork", () => {
    expect(getStorefrontMenuArtwork("upper-body")).toEqual({
      src: "/images/categories/megamenu/upper-body.webp",
      alt: "بالا تنه",
    });
    expect(getStorefrontMenuArtwork("lower-body")?.src).toBe(
      "/images/categories/megamenu/lower-body.webp",
    );
    expect(getStorefrontMenuArtwork("sportswear")?.src).toBe(
      "/images/categories/megamenu/sportswear.webp",
    );
    expect(getStorefrontMenuArtwork("underwear")?.src).toBe(
      "/images/categories/megamenu/underwear.webp",
    );
  });

  it("does not map the excluded leaf and nested artwork", () => {
    expect(getStorefrontMenuArtwork("bag")).toBeNull();
    expect(getStorefrontMenuArtwork("shoes")).toBeNull();
    expect(getStorefrontMenuArtwork("shirt")).toBeNull();
    expect(getStorefrontMenuArtwork("coat-bomber")).toBeNull();
  });
});
