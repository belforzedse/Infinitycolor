import arvanImageLoader from "../arvanImageLoader";

const CDN = "https://cdn.infinitycolor.co";
const API = "https://api.infinitycolor.co";

describe("arvanImageLoader", () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env.NEXT_PUBLIC_MEDIA_CDN_URL = CDN;
    process.env.NEXT_PUBLIC_IMAGE_BASE_URL = API;
    process.env.NEXT_PUBLIC_API_BASE_URL = `${API}/api`;
    delete process.env.NEXT_PUBLIC_IMAGE_LOADER;
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it("sends catalogue media to the CDN with a width parameter", () => {
    const url = new URL(arvanImageLoader({ src: "/uploads/shirt.webp", width: 640, quality: 70 }));

    expect(url.origin).toBe(CDN);
    expect(url.pathname).toBe("/uploads/shirt.webp");
    expect(url.searchParams.get("width")).toBe("640");
  });

  it("rewrites an upload already addressed at the API origin", () => {
    const url = new URL(arvanImageLoader({ src: `${API}/uploads/shirt.webp`, width: 828, quality: 70 }));

    expect(url.origin).toBe(CDN);
    expect(url.searchParams.get("width")).toBe("828");
  });

  // The edge stores one derivative per distinct width, so an arbitrary layout
  // width must not become an arbitrary cache key.
  it.each([
    [1, 16],
    [100, 128],
    [641, 750],
    [1500, 1920],
    [99999, 3840],
  ])("snaps a requested width of %i up to %i", (requested, expected) => {
    const url = new URL(arvanImageLoader({ src: "/uploads/shirt.webp", width: requested, quality: 70 }));
    expect(url.searchParams.get("width")).toBe(String(expected));
  });

  // 1,642 of 3,442 slugs are non-ASCII and the filenames follow.
  it("preserves a Persian filename as a valid encoded URL", () => {
    const result = arvanImageLoader({ src: "/uploads/پیراهن-مردانه.webp", width: 640, quality: 70 });
    const url = new URL(result);

    expect(url.origin).toBe(CDN);
    expect(decodeURIComponent(url.pathname)).toBe("/uploads/پیراهن-مردانه.webp");
    expect(url.searchParams.get("width")).toBe("640");
  });

  it("does not add a second width when one is already present", () => {
    const result = arvanImageLoader({ src: "/uploads/shirt.webp?width=999", width: 640, quality: 70 });
    expect(result.match(/width=/g)).toHaveLength(1);
    expect(new URL(result).searchParams.get("width")).toBe("640");
  });

  // Arvan's resize takes width and height only; a quality parameter would just
  // fork the cache for an identical image.
  it("ignores quality", () => {
    const a = arvanImageLoader({ src: "/uploads/shirt.webp", width: 640, quality: 50 });
    const b = arvanImageLoader({ src: "/uploads/shirt.webp", width: 640, quality: 95 });
    expect(a).toBe(b);
  });

  describe("what must not go to the CDN", () => {
    it("leaves a data URI untouched", () => {
      const src = "data:image/png;base64,iVBORw0KGgo=";
      expect(arvanImageLoader({ src, width: 640, quality: 70 })).toBe(src);
    });

    // `images.loader: "custom"` removes `/_next/image` from the server, so a
    // public asset has to be returned as the plain path the app already serves.
    it("serves local public assets from their own path, untouched", () => {
      const result = arvanImageLoader({ src: "/images/hero.png", width: 640, quality: 70 });
      expect(result).toBe("/images/hero.png");
      expect(result).not.toContain(CDN);
      expect(result).not.toContain("/_next/image");
    });

    it("returns nothing for a source the allowlist rejects", () => {
      expect(arvanImageLoader({ src: "https://evil.example.com/uploads/x.webp", width: 640, quality: 70 })).toBe("");
      expect(arvanImageLoader({ src: "//evil.example.com/uploads/x.webp", width: 640, quality: 70 })).toBe("");
    });
  });

  describe("fallbacks", () => {
    it("serves uploads straight from the API origin when no CDN is configured", () => {
      process.env.NEXT_PUBLIC_MEDIA_CDN_URL = "";

      const result = arvanImageLoader({ src: "/uploads/shirt.webp", width: 640, quality: 70 });
      expect(result).toBe(`${API}/uploads/shirt.webp`);
      expect(result).not.toContain("/_next/image");
    });

    // The rollback: one changed build argument, no code change. It cannot mean
    // "use the Next optimizer" any more — a custom loader removes it — so it
    // means "stop asking the edge to resize".
    it("stops emitting a width when the loader is pinned back to next", () => {
      process.env.NEXT_PUBLIC_IMAGE_LOADER = "next";

      const result = arvanImageLoader({ src: "/uploads/shirt.webp", width: 640, quality: 70 });
      expect(result).toBe(`${CDN}/uploads/shirt.webp`);
      expect(result).not.toContain("/_next/image");
    });
  });

  // Arvan resizes JPG, PNG and WebP only; any other format is returned
  // untouched, so a width would mint a cache key per breakpoint for identical
  // bytes. GIF is the case that actually breaks: the edge resizes the first
  // frame and stores it as a still, and apps/frontend/AGENTS.md requires
  // storefront GIFs keep their animated source.
  describe("formats the edge cannot resize", () => {
    it.each([["gif"], ["GIF"], ["svg"], ["mp4"], ["mov"], ["webm"], ["avif"]])(
      "serves .%s from the CDN with no width",
      (extension) => {
        const result = arvanImageLoader({
          src: `/uploads/banner.${extension}`,
          width: 640,
          quality: 70,
        });
        const url = new URL(result);

        expect(url.origin).toBe(CDN);
        expect(url.pathname).toBe(`/uploads/banner.${extension}`);
        expect(url.search).toBe("");
        expect(result).not.toContain("/_next/image");
      },
    );

    it("collapses every breakpoint of a GIF onto one cache key", () => {
      const widths = [16, 640, 1920, 3840];
      const urls = new Set(
        widths.map((width) => arvanImageLoader({ src: "/uploads/banner.gif", width, quality: 70 })),
      );

      expect(urls.size).toBe(1);
    });

    // public/ holds Slide4Foreground.PNG, so the extension test cannot be
    // case-sensitive in the other direction either.
    it.each([["PNG"], ["JPG"], ["Jpeg"], ["WEBP"]])("still resizes .%s", (extension) => {
      const url = new URL(
        arvanImageLoader({ src: `/uploads/shirt.${extension}`, width: 640, quality: 70 }),
      );

      expect(url.searchParams.get("width")).toBe("640");
    });

    it("reads the extension from the path, not a query string", () => {
      const url = new URL(
        arvanImageLoader({ src: "/uploads/banner.gif?updatedAt=123", width: 640, quality: 70 }),
      );

      expect(url.searchParams.has("width")).toBe(false);
    });
  });

});
