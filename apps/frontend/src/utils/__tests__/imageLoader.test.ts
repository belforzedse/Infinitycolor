import imageLoader from "../imageLoader";

describe("imageLoader", () => {
  const originalEnv = process.env.NEXT_PUBLIC_IMAGE_BASE_URL;

  afterEach(() => {
    // Restore properly: assigning `undefined` to a process.env key coerces it to
    // the string "undefined", which would break later tests (e.g. the fallback
    // case uses it as a URL base). Delete it when it was originally unset.
    if (originalEnv === undefined) {
      delete process.env.NEXT_PUBLIC_IMAGE_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_IMAGE_BASE_URL = originalEnv;
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

  it("should add width and quality parameters", () => {
    const result = imageLoader({ src: "/images/image.jpg", width: 800, quality: 90 });

    expect(result).toContain("w=800");
    expect(result).toContain("q=90");
  });

  it("should use default quality of 70", () => {
    const result = imageLoader({ src: "/images/image.jpg", width: 800 });

    expect(result).toContain("q=70");
  });

  it("should add avif format parameter", () => {
    const result = imageLoader({ src: "/images/image.jpg", width: 800 });

    expect(result).toContain("f=avif");
  });

  it("should handle trusted absolute Strapi upload URLs", () => {
    process.env.NEXT_PUBLIC_IMAGE_BASE_URL = "https://api.infinitycolor.co";

    const result = imageLoader({
      src: "https://api.infinitycolor.co/uploads/image.jpg",
      width: 800,
    });

    expect(result).toContain("https://api.infinitycolor.co/uploads/image.jpg");
    expect(result).toContain("w=800");
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

    expect(result).toContain("https://cdn.example.com/uploads/image.jpg");
    expect(result).toContain("w=800");
  });

  it("should handle local public URLs with existing query parameters", () => {
    const result = imageLoader({
      src: "/images/image.jpg?existing=param",
      width: 800,
    });

    expect(result).toContain("existing=param");
    expect(result).toContain("w=800");
  });

  it("should reject unrecognized relative sources instead of treating them as remote images", () => {
    const invalidUrl = "not a valid url with spaces";
    const result = imageLoader({ src: invalidUrl, width: 800, quality: 90 });

    expect(result).toBe("");
  });

  it("should use & for URLs with existing params in fallback", () => {
    const urlWithParams = "/images/image.jpg?existing=param";
    const result = imageLoader({ src: urlWithParams, width: 800, quality: 90 });

    // Should either use proper URL parsing or fallback with &
    expect(result).toMatch(/[?&]w=800/);
  });

  it("should handle different width values", () => {
    const result1 = imageLoader({ src: "/images/image.jpg", width: 400 });
    const result2 = imageLoader({ src: "/images/image.jpg", width: 1920 });

    expect(result1).toContain("w=400");
    expect(result2).toContain("w=1920");
  });

  it("should convert width to string", () => {
    const result = imageLoader({ src: "/images/image.jpg", width: 800 });

    expect(result).toContain("w=800");
    expect(result).not.toContain("w=[object");
  });
});
