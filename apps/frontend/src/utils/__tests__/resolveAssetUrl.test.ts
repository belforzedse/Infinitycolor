import { resolveAssetUrl } from "../resolveAssetUrl";

describe("resolveAssetUrl", () => {
  const originalImageBase = process.env.NEXT_PUBLIC_IMAGE_BASE_URL;

  afterEach(() => {
    if (originalImageBase === undefined) {
      delete process.env.NEXT_PUBLIC_IMAGE_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_IMAGE_BASE_URL = originalImageBase;
    }
  });

  it("resolves Strapi upload paths against the configured image base", () => {
    process.env.NEXT_PUBLIC_IMAGE_BASE_URL = "https://api.infinitycolor.co";

    expect(resolveAssetUrl("/uploads/product.webp")).toBe(
      "https://api.infinitycolor.co/uploads/product.webp",
    );
    expect(resolveAssetUrl("uploads/product.webp")).toBe(
      "https://api.infinitycolor.co/uploads/product.webp",
    );
  });

  it("preserves trusted absolute Strapi upload URLs", () => {
    process.env.NEXT_PUBLIC_IMAGE_BASE_URL = "https://api.infinitycolor.co";

    expect(resolveAssetUrl("https://api.infinitycolor.co/uploads/product.webp")).toBe(
      "https://api.infinitycolor.co/uploads/product.webp",
    );
  });

  it("returns an empty string for arbitrary external images", () => {
    expect(resolveAssetUrl("https://external-domain.example/product.webp")).toBe("");
  });

  it("keeps local public assets on the frontend origin", () => {
    expect(resolveAssetUrl("/images/placeholders/image-placeholder.svg")).toBe(
      "/images/placeholders/image-placeholder.svg",
    );
  });

  it("allows data image placeholders", () => {
    const src = "data:image/svg+xml;base64,PHN2Zy8+";

    expect(resolveAssetUrl(src)).toBe(src);
  });
});
