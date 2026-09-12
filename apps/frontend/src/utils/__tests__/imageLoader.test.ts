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

  // `images.loader: "custom"` makes the Next server 404 `/_next/image`, so a
  // local public asset must come back as the path the app already serves.
  it("should serve a local public asset from its own path", () => {
    const result = imageLoader({ src: "/images/image.jpg", width: 800, quality: 90 });

    expect(result).toBe("/images/image.jpg");
    expect(result).not.toContain("/_next/image");
  });

  it("should not vary a local public asset by width or quality", () => {
    const narrow = imageLoader({ src: "/images/image.jpg", width: 16, quality: 50 });
    const wide = imageLoader({ src: "/images/image.jpg", width: 3840, quality: 95 });

    expect(narrow).toBe(wide);
  });

  it("should serve a trusted absolute Strapi upload URL as-is when no CDN is configured", () => {
    process.env.NEXT_PUBLIC_IMAGE_BASE_URL = "https://api.infinitycolor.co";
    delete process.env.NEXT_PUBLIC_MEDIA_CDN_URL;

    const result = imageLoader({
      src: "https://api.infinitycolor.co/uploads/image.jpg",
      width: 800,
    });

    expect(result).toBe("https://api.infinitycolor.co/uploads/image.jpg");
    expect(result).not.toContain("/_next/image");
  });

  it("should reject arbitrary external absolute URLs", () => {
    const result = imageLoader({
      src: "https://example.com/image.jpg",
      width: 800,
    });

    expect(result).toBe("");
  });

  it("should absolutize a relative upload against BASE_URL when no CDN is configured", () => {
    process.env.NEXT_PUBLIC_IMAGE_BASE_URL = "https://cdn.example.com";
    delete process.env.NEXT_PUBLIC_MEDIA_CDN_URL;

    const result = imageLoader({ src: "/uploads/image.jpg", width: 800 });

    expect(result).toBe("https://cdn.example.com/uploads/image.jpg");
    expect(result).not.toContain("/_next/image");
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

  it("keeps local public assets off the CDN even when one is configured", () => {
    process.env.NEXT_PUBLIC_MEDIA_CDN_URL = "https://cdn.infinitycolor.co";

    const result = imageLoader({ src: "/images/image.jpg", width: 800 });

    expect(result).toBe("/images/image.jpg");
    expect(result).not.toContain("cdn.infinitycolor.co");
  });

  it("should preserve an existing query string on a local public URL", () => {
    const result = imageLoader({
      src: "/images/image.jpg?existing=param",
      width: 800,
    });

    expect(result).toBe("/images/image.jpg?existing=param");
  });

  it("should reject unrecognized relative sources instead of treating them as remote images", () => {
    const invalidUrl = "not a valid url with spaces";
    const result = imageLoader({ src: invalidUrl, width: 800, quality: 90 });

    expect(result).toBe("");
  });

  it("should handle different width values", () => {
    process.env.NEXT_PUBLIC_MEDIA_CDN_URL = "https://cdn.infinitycolor.co";

    const result1 = imageLoader({ src: "/uploads/image.jpg", width: 400 });
    const result2 = imageLoader({ src: "/uploads/image.jpg", width: 1920 });

    expect(parseResult(result1).searchParams.get("width")).toBe("640");
    expect(parseResult(result2).searchParams.get("width")).toBe("1920");
  });

  it("should snap unsupported widths up to configured Next image widths", () => {
    process.env.NEXT_PUBLIC_MEDIA_CDN_URL = "https://cdn.infinitycolor.co";

    const invalidDesktopWidth = imageLoader({ src: "/uploads/image.jpg", width: 2568 });
    const invalidHeroWidth = imageLoader({ src: "/uploads/image.jpg", width: 1208 });
    const smallAvatarWidth = imageLoader({ src: "/uploads/image.jpg", width: 74 });

    expect(parseResult(invalidDesktopWidth).searchParams.get("width")).toBe("3840");
    expect(parseResult(invalidHeroWidth).searchParams.get("width")).toBe("1920");
    expect(parseResult(smallAvatarWidth).searchParams.get("width")).toBe("96");
  });

  it("should convert width to string", () => {
    process.env.NEXT_PUBLIC_MEDIA_CDN_URL = "https://cdn.infinitycolor.co";

    const result = imageLoader({ src: "/uploads/image.jpg", width: 800 });
    const url = parseResult(result);

    expect(url.searchParams.get("width")).toBe("828");
    expect(result).not.toContain("width=[object");
  });

  // The regression that took every `public/` image down in wt202609121652: a
  // loader branch emitted `/_next/image`, which the server 404s whenever
  // `images.loader !== "default"`. No input may produce that path.
  it("never emits the optimizer path, whatever the input", () => {
    process.env.NEXT_PUBLIC_IMAGE_BASE_URL = "https://api.infinitycolor.co";
    process.env.NEXT_PUBLIC_MEDIA_CDN_URL = "https://cdn.infinitycolor.co";

    const sources = [
      "/images/image.jpg",
      "/images/logo.PNG",
      "/images/banner.svg",
      "/uploads/shirt.webp",
      "/uploads/banner.gif",
      "https://api.infinitycolor.co/uploads/image.jpg",
      "data:image/png;base64,iVBORw0KGgo=",
    ];

    for (const src of sources) {
      for (const width of [16, 828, 3840]) {
        expect(imageLoader({ src, width })).not.toContain("/_next/image");
      }
    }
  });
});
