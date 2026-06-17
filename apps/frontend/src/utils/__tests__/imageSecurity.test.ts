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

  function parseOptimizerUrl(value: string): URL {
    return new URL(value, "https://new.infinitycolor.local");
  }

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

  it("builds Next optimizer URLs only for allowed sources", () => {
    const result = buildOptimizedImageUrl(
      "https://api.infinitycolor.co/uploads/cover.webp",
      800,
      75,
      productionOptions,
    );
    const url = parseOptimizerUrl(result);

    expect(url.pathname).toBe("/_next/image");
    expect(url.searchParams.get("url")).toBe("https://api.infinitycolor.co/uploads/cover.webp");
    expect(url.searchParams.get("w")).toBe("828");
    expect(url.searchParams.get("q")).toBe("75");
    expect(url.searchParams.has("f")).toBe(false);
    expect(buildOptimizedImageUrl("https://external-domain.example/cover.webp", 800, 75, productionOptions)).toBe("");
  });

  it("snaps unsupported optimizer widths up to configured Next image widths", () => {
    expect(
      parseOptimizerUrl(
        buildOptimizedImageUrl("https://api.infinitycolor.co/uploads/cover.webp", 2568, 75, productionOptions),
      ).searchParams.get("w"),
    ).toBe("3840");
    expect(
      parseOptimizerUrl(
        buildOptimizedImageUrl("https://api.infinitycolor.co/uploads/cover.webp", 1208, 75, productionOptions),
      ).searchParams.get("w"),
    ).toBe("1920");
    expect(
      parseOptimizerUrl(
        buildOptimizedImageUrl("https://api.infinitycolor.co/uploads/cover.webp", 74, 75, productionOptions),
      ).searchParams.get("w"),
    ).toBe("96");
  });

  describe("media CDN routing", () => {
    const cdnOptions = {
      ...productionOptions,
      mediaCdnUrl: "https://cdn.infinitycolor.co",
    };

    it.each([null, undefined, ""])("returns empty string for %p", (value) => {
      expect(resolveSafeImageSrc(value, cdnOptions)).toBe("");
    });

    it("rewrites relative /uploads paths to the CDN origin", () => {
      expect(resolveSafeImageSrc("/uploads/a.jpg", cdnOptions)).toBe(
        "https://cdn.infinitycolor.co/uploads/a.jpg",
      );
    });

    it("rewrites absolute Strapi upload URLs to the CDN origin", () => {
      expect(resolveSafeImageSrc("https://api.infinitycolor.co/uploads/a.jpg", cdnOptions)).toBe(
        "https://cdn.infinitycolor.co/uploads/a.jpg",
      );
    });

    it("normalizes whitespace in malformed Strapi upload URLs before CDN routing", () => {
      expect(resolveSafeImageSrc("https://api.infinitycolor.co /uploads/a.webp", cdnOptions)).toBe(
        "https://cdn.infinitycolor.co/uploads/a.webp",
      );
    });

    it("leaves already-CDN upload URLs unchanged", () => {
      expect(resolveSafeImageSrc("https://cdn.infinitycolor.co/uploads/a.jpg", cdnOptions)).toBe(
        "https://cdn.infinitycolor.co/uploads/a.jpg",
      );
    });

    it("still rejects unrelated external URLs", () => {
      expect(resolveSafeImageSrc("https://external-site.com/image.jpg", cdnOptions)).toBe("");
    });

    it("does not rewrite non-upload Strapi API URLs", () => {
      expect(resolveSafeImageSrc("https://api.infinitycolor.co/admin/logo.png", cdnOptions)).toBe("");
      expect(resolveSafeImageSrc("https://api.infinitycolor.co/api/products", cdnOptions)).toBe("");
    });

    it("optimizes CDN-routed upload URLs through Next image optimizer", () => {
      const result = buildOptimizedImageUrl("/uploads/cover.webp", 800, 75, cdnOptions);
      const url = parseOptimizerUrl(result);

      expect(url.pathname).toBe("/_next/image");
      expect(url.searchParams.get("url")).toBe("https://cdn.infinitycolor.co/uploads/cover.webp");
      expect(url.searchParams.get("w")).toBe("828");
      expect(url.searchParams.get("q")).toBe("75");
      expect(url.searchParams.has("f")).toBe(false);
    });

    it("adds the CDN host to the Next.js remote patterns", () => {
      expect(getNextImageRemotePatterns(cdnOptions)).toContainEqual({
        protocol: "https",
        hostname: "cdn.infinitycolor.co",
        port: "",
        pathname: "/uploads/**",
      });
    });

    it("preserves origin behavior when no CDN is configured", () => {
      expect(resolveSafeImageSrc("/uploads/a.jpg", productionOptions)).toBe(
        "https://api.infinitycolor.co/uploads/a.jpg",
      );
      expect(resolveSafeImageSrc("https://api.infinitycolor.co/uploads/a.jpg", productionOptions)).toBe(
        "https://api.infinitycolor.co/uploads/a.jpg",
      );
    });
  });
});
