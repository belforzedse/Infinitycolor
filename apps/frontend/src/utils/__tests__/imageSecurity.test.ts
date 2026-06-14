import {
  buildOptimizedImageUrl,
  getNextImageRemotePatterns,
  isAllowedImageUrl,
  resolveSafeImageSrc,
} from "../imageSecurity";

describe("imageSecurity", () => {
  const productionOptions = {
    production: true,
    imageBaseUrl: "https://api.infinitycolor.co",
    apiBaseUrl: "https://api.infinitycolor.co/api",
  };

  it("builds strict production Next.js remote patterns for Strapi uploads only", () => {
    const patterns = getNextImageRemotePatterns(productionOptions);

    expect(patterns).toEqual([
      {
        protocol: "https",
        hostname: "api.infinitycolor.co",
        port: "",
        pathname: "/uploads/**",
      },
    ]);
    expect(patterns).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostname: "*" }),
        expect.objectContaining({ hostname: "**" }),
      ]),
    );
  });

  it("allows trusted Strapi upload image URLs", () => {
    expect(
      isAllowedImageUrl("https://api.infinitycolor.co/uploads/products/cover.webp", productionOptions),
    ).toBe(true);
    expect(resolveSafeImageSrc("/uploads/products/cover.webp", productionOptions)).toBe(
      "https://api.infinitycolor.co/uploads/products/cover.webp",
    );
  });

  it("rejects arbitrary external image origins", () => {
    expect(resolveSafeImageSrc("https://external-domain.example/image.jpg", productionOptions)).toBe("");
    expect(resolveSafeImageSrc("https://api.infinitycolor.co.evil.example/uploads/a.jpg", productionOptions)).toBe("");
  });

  it("rejects non-upload paths even on trusted origins", () => {
    expect(resolveSafeImageSrc("https://api.infinitycolor.co/admin/logo.png", productionOptions)).toBe("");
  });

  it.each([
    "http://localhost:1337/uploads/a.jpg",
    "http://127.0.0.1:1337/uploads/a.jpg",
    "http://10.0.0.5/uploads/a.jpg",
    "http://172.16.1.10/uploads/a.jpg",
    "http://192.168.1.10/uploads/a.jpg",
    "http://169.254.169.254/latest/meta-data",
    "http://metadata.google.internal/computeMetadata/v1",
    "http://strapi.internal/uploads/a.jpg",
  ])("rejects internal or private production target %s", (url) => {
    expect(resolveSafeImageSrc(url, productionOptions)).toBe("");
  });

  it("allows configured local Strapi uploads outside production", () => {
    expect(
      resolveSafeImageSrc("/uploads/local.webp", {
        production: false,
        imageBaseUrl: "http://127.0.0.1:1337",
        apiBaseUrl: "http://127.0.0.1:1337/api",
      }),
    ).toBe("http://127.0.0.1:1337/uploads/local.webp");
  });

  it("allows configured single-label service hosts outside production for CI e2e uploads", () => {
    expect(
      resolveSafeImageSrc("/uploads/e2e.webp", {
        production: false,
        imageBaseUrl: "http://backend:1337",
        apiBaseUrl: "http://backend:1337/api",
      }),
    ).toBe("http://backend:1337/uploads/e2e.webp");

    expect(
      getNextImageRemotePatterns({
        production: false,
        imageBaseUrl: "http://backend:1337",
        apiBaseUrl: "http://backend:1337/api",
      }),
    ).toContainEqual({
      protocol: "http",
      hostname: "backend",
      port: "1337",
      pathname: "/uploads/**",
    });
  });

  it("allows local public assets without treating protocol-relative URLs as local assets", () => {
    expect(resolveSafeImageSrc("/images/cart/zarinpal.svg", productionOptions)).toBe(
      "/images/cart/zarinpal.svg",
    );
    expect(resolveSafeImageSrc("//external-domain.example/image.jpg", productionOptions)).toBe("");
  });

  it("adds image optimization params only to allowed sources", () => {
    expect(
      buildOptimizedImageUrl("https://api.infinitycolor.co/uploads/cover.webp", 800, 75, productionOptions),
    ).toBe("https://api.infinitycolor.co/uploads/cover.webp?w=800&q=75&f=avif");
    expect(buildOptimizedImageUrl("https://external-domain.example/cover.webp", 800, 75, productionOptions)).toBe("");
  });
});
