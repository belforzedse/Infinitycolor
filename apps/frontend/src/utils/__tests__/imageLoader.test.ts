import imageLoader from "../imageLoader";

describe("imageLoader", () => {
  const originalEnv = process.env.NEXT_PUBLIC_IMAGE_BASE_URL;
  const originalCdnEnv = process.env.NEXT_PUBLIC_MEDIA_CDN_URL;

  function parseResult(value: string): URL {
    return new URL(value, "https://new.infinitycolor.local");
  }

  afterEach(() => {
    // Restore properly: assigning `undefined` to a process.env key coerces it to
    // the string "undefined", which would break later tests (e.g. the fallback
    // case uses it as a URL base). Delete it when it was originally unset.
    if (originalEnv === undefined) {
      delete process.env.NEXT_PUBLIC_IMAGE_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_IMAGE_BASE_URL = originalEnv;
    }
    if (originalCdnEnv === undefined) {
      delete process.env.NEXT_PUBLIC_MEDIA_CDN_URL;
    } else {
      process.env.NEXT_PUBLIC_MEDIA_CDN_URL = originalCdnEnv;
    }
  });

  it("should return data URLs unchanged", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const result = imageLoader({ src: dataUrl, width: 800 });

    expect(result).toBe(dataUrl);
  });

  it("should return empty sources unchanged", () => {
    const result = imageLoader({ src: "", width: 800 });

    expect(result).toBe("");
  });

  it("should route through the Next image optimizer with width and quality parameters", () => {
    const result = imageLoader({ src: "/images/image.jpg", width: 800, quality: 90 });
    const url = parseResult(result);

    expect(url.pathname).toBe("/_next/image");
    expect(url.searchParams.get("url")).toBe("/images/image.jpg");
    expect(url.searchParams.get("w")).toBe("828");
    expect(url.searchParams.get("q")).toBe("90");
  });

  it("should use default quality of 70", () => {
    const result = imageLoader({ src: "/images/image.jpg", width: 800 });
    const url = parseResult(result);

    expect(url.searchParams.get("q")).toBe("70");
  });

  it("should not add fake CDN format parameters", () => {
    const result = imageLoader({ src: "/images/image.jpg", width: 800 });
    const url = parseResult(result);

    expect(url.searchParams.has("f")).toBe(false);
  });

  it("should handle trusted absolute Strapi upload URLs", () => {
    process.env.NEXT_PUBLIC_IMAGE_BASE_URL = "https://api.infinitycolor.co";

    const result = imageLoader({
      src: "https://api.infinitycolor.co/uploads/image.jpg",
      width: 800,
    });
    const url = parseResult(result);

    expect(url.searchParams.get("url")).toBe("https://api.infinitycolor.co/uploads/image.jpg");
    expect(url.searchParams.get("w")).toBe("828");
  });

  it("should reject arbitrary external absolute URLs", () => {
    const result = imageLoader({
      src: "https://example.com/image.jpg",
      width: 800,
    });

    expect(result).toBe("");
  });

  it("should handle relative URLs with BASE_URL", () => {
    process.env.NEXT_PUBLIC_IMAGE_BASE_URL = "https://cdn.example.com";

    const result = imageLoader({ src: "/uploads/image.jpg", width: 800 });
    const url = parseResult(result);

    expect(url.searchParams.get("url")).toBe("https://cdn.example.com/uploads/image.jpg");
    expect(url.searchParams.get("w")).toBe("828");
  });

  // This loader is passed explicitly as `loader={imageLoader}` by the product
  // cards, the PDP gallery, cart and order rows and the banners. An explicit
  // loader prop bypasses images.loaderFile, so these call sites reach the edge
  // only because this module shares the policy — hence the coverage here and
  // not only in arvanImageLoader.test.ts.
  it("sends relative uploads to the media CDN to be resized, not to the optimizer", () => {
    process.env.NEXT_PUBLIC_IMAGE_BASE_URL = "https://api.infinitycolor.co";
    process.env.NEXT_PUBLIC_MEDIA_CDN_URL = "https://cdn.infinitycolor.co";

    const result = imageLoader({ src: "/uploads/image.jpg", width: 800 });
    const url = parseResult(result);

    expect(url.origin).toBe("https://cdn.infinitycolor.co");
    expect(url.pathname).toBe("/uploads/image.jpg");
    expect(url.searchParams.get("width")).toBe("828");
    expect(result).not.toContain("/_next/image");
  });

  it("leaves a catalogue GIF animated by never asking the edge to resize it", () => {
    process.env.NEXT_PUBLIC_IMAGE_BASE_URL = "https://api.infinitycolor.co";
    process.env.NEXT_PUBLIC_MEDIA_CDN_URL = "https://cdn.infinitycolor.co";

    const result = imageLoader({ src: "/uploads/banner.gif", width: 800 });

    expect(result).toBe("https://cdn.infinitycolor.co/uploads/banner.gif");
  });

  it("keeps local public assets on the optimizer even with the CDN configured", () => {
    process.env.NEXT_PUBLIC_MEDIA_CDN_URL = "https://cdn.infinitycolor.co";

    const result = imageLoader({ src: "/images/image.jpg", width: 800 });
    const url = parseResult(result);

    expect(url.pathname).toBe("/_next/image");
    expect(result).not.toContain("cdn.infinitycolor.co");
  });

  it("should handle local public URLs with existing query parameters", () => {
    const result = imageLoader({
      src: "/images/image.jpg?existing=param",
      width: 800,
    });
    const url = parseResult(result);

    expect(url.searchParams.get("url")).toBe("/images/image.jpg?existing=param");
    expect(url.searchParams.get("w")).toBe("828");
  });

  it("should reject unrecognized relative sources instead of treating them as remote images", () => {
    const invalidUrl = "not a valid url with spaces";
    const result = imageLoader({ src: invalidUrl, width: 800, quality: 90 });

    expect(result).toBe("");
  });

  it("should use & for URLs with existing params in fallback", () => {
    const urlWithParams = "/images/image.jpg?existing=param";
    const result = imageLoader({ src: urlWithParams, width: 800, quality: 90 });
    const url = parseResult(result);

    expect(url.pathname).toBe("/_next/image");
    expect(url.searchParams.get("url")).toBe("/images/image.jpg?existing=param");
    expect(url.searchParams.get("w")).toBe("828");
  });

  it("should handle different width values", () => {
    const result1 = imageLoader({ src: "/images/image.jpg", width: 400 });
    const result2 = imageLoader({ src: "/images/image.jpg", width: 1920 });

    expect(parseResult(result1).searchParams.get("w")).toBe("640");
    expect(parseResult(result2).searchParams.get("w")).toBe("1920");
  });

  it("should snap unsupported widths up to configured Next image widths", () => {
    const invalidDesktopWidth = imageLoader({ src: "/images/image.jpg", width: 2568 });
    const invalidHeroWidth = imageLoader({ src: "/images/image.jpg", width: 1208 });
    const smallAvatarWidth = imageLoader({ src: "/images/image.jpg", width: 74 });

    expect(parseResult(invalidDesktopWidth).searchParams.get("w")).toBe("3840");
    expect(parseResult(invalidHeroWidth).searchParams.get("w")).toBe("1920");
    expect(parseResult(smallAvatarWidth).searchParams.get("w")).toBe("96");
  });

  it("should convert width to string", () => {
    const result = imageLoader({ src: "/images/image.jpg", width: 800 });
    const url = parseResult(result);

    expect(url.searchParams.get("w")).toBe("828");
    expect(result).not.toContain("w=[object");
  });
});
