import {
  CATEGORY_EDITORIAL_IMPORT_SOURCE,
  categoryEditorialSeoDescription,
  sanitizeCategoryEditorial,
  sanitizePublicCategoryEditorial,
} from "../services/category-editorial-sanitizer";

describe("category editorial sanitizer", () => {
  it("keeps useful semantic content while removing executable and styling input", () => {
    const value = sanitizeCategoryEditorial({
      Title: "  <b>راهنمای خرید</b>  ",
      Paragraph: "  مقدمه  ",
      Content:
        '<h1 onclick="run()">بخش</h1><p style="color:red">متن <a href="javascript:alert(1)">بد</a></p><script>alert(1)</script><img src="https://cdn.example/x.jpg" alt="نمای محصول" onerror="run()">',
      IsPublished: true,
      IsRTL: true,
    });

    expect(value.Title).toBe("راهنمای خرید");
    expect(value.Content).toContain("<h3>بخش</h3>");
    expect(value.Content).toContain('alt="نمای محصول"');
    expect(value.Content).not.toMatch(/script|onclick|onerror|style=|javascript:/i);
  });

  it("requires a heading and meaningful published content", () => {
    expect(() => sanitizeCategoryEditorial({ Title: "", IsPublished: false })).toThrow(
      "EDITORIAL_TITLE_REQUIRED",
    );
    expect(() =>
      sanitizeCategoryEditorial({ Title: "عنوان", Content: "<p>&nbsp;</p>", IsPublished: true }),
    ).toThrow("EDITORIAL_PUBLISHED_CONTENT_REQUIRED");
  });

  it("rejects images without alt text on write and drops them from legacy public data", () => {
    const input = {
      id: 9,
      Title: "عنوان",
      Paragraph: "مقدمه",
      Content: '<p>متن</p><img src="https://cdn.example/x.jpg">',
      IsPublished: true,
      IsRTL: true,
    };
    expect(() => sanitizeCategoryEditorial(input)).toThrow("EDITORIAL_IMAGE_ALT_REQUIRED");
    expect(sanitizePublicCategoryEditorial(input)?.content).toBe("<p>متن</p>");
  });

  it("never projects drafts", () => {
    expect(
      sanitizePublicCategoryEditorial({
        id: 1,
        Title: "عنوان",
        Paragraph: "متن",
        IsPublished: false,
      }),
    ).toBeNull();
  });

  it("treats invalid legacy published rows as unavailable", () => {
    expect(
      sanitizePublicCategoryEditorial({
        id: 2,
        Title: "",
        Paragraph: "متن",
        IsPublished: true,
      }),
    ).toBeNull();
  });

  it("rejects oversized values instead of silently truncating them", () => {
    expect(() =>
      sanitizeCategoryEditorial({ Title: "ت".repeat(181), IsPublished: false }),
    ).toThrow("EDITORIAL_TITLE_TOO_LONG");
    expect(() =>
      sanitizeCategoryEditorial({
        Title: "عنوان",
        Paragraph: "م".repeat(4_001),
        IsPublished: false,
      }),
    ).toThrow("EDITORIAL_PARAGRAPH_TOO_LONG");
    expect(() =>
      sanitizeCategoryEditorial({
        Title: "عنوان",
        Content: "م".repeat(120_001),
        IsPublished: false,
      }),
    ).toThrow("EDITORIAL_CONTENT_TOO_LONG");
  });

  it("projects imported title-only rows with local audio and a computed SEO summary", () => {
    const projected = sanitizePublicCategoryEditorial({
      id: 14,
      Title: "خرید پوشاک زنانه",
      Paragraph: "",
      Content: "",
      IsPublished: true,
      IsRTL: true,
      ImportSource: CATEGORY_EDITORIAL_IMPORT_SOURCE,
      Audio: {
        id: 71,
        name: "guide.mp3",
        mime: "audio/mpeg",
        url: "/uploads/guide.mp3",
      },
    });
    expect(projected).toEqual(
      expect.objectContaining({
        title: "خرید پوشاک زنانه",
        seoDescription: "خرید پوشاک زنانه",
        audio: {
          name: "guide.mp3",
          mime: "audio/mpeg",
          url: "/uploads/guide.mp3",
        },
      }),
    );
  });

  it("computes a bounded word-safe SEO description from introduction and body", () => {
    const summary = categoryEditorialSeoDescription({
      Title: "عنوان",
      Paragraph: "مقدمه",
      Content: `<p>${"واژه ".repeat(80)}</p>`,
    });
    expect(summary.length).toBeLessThanOrEqual(181);
    expect(summary).toMatch(/^مقدمه/);
    expect(summary).toMatch(/…$/);
  });
});
