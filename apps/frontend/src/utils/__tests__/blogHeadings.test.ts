import { extractBlogHeadings } from "../blogHeadings";

describe("extractBlogHeadings", () => {
  it("assigns section-n ids to Persian headings and returns their visible text", () => {
    const { html, headings } = extractBlogHeadings(`
      <h2>راهنمای انتخاب لباس</h2>
      <p>متن</p>
      <h3>انتخاب سایز مناسب</h3>
    `);

    expect(headings).toEqual([
      { id: "section-1", text: "راهنمای انتخاب لباس", level: 2 },
      { id: "section-2", text: "انتخاب سایز مناسب", level: 3 },
    ]);
    expect(html).toContain('<h2 id="section-1">راهنمای انتخاب لباس</h2>');
    expect(html).toContain('<h3 id="section-2">انتخاب سایز مناسب</h3>');
  });

  it("strips nested tags from the TOC label", () => {
    const { headings } = extractBlogHeadings(
      `<h2>رنگ شناسی <strong>لباس</strong> و پوشاک</h2>`,
    );

    expect(headings).toEqual([
      { id: "section-1", text: "رنگ شناسی لباس و پوشاک", level: 2 },
    ]);
  });

  it("keeps an existing heading id", () => {
    const { html, headings } = extractBlogHeadings(
      `<h2 id="intro">مقدمه</h2><h3>ادامه</h3>`,
    );

    expect(headings[0]).toEqual({ id: "intro", text: "مقدمه", level: 2 });
    expect(headings[1]).toEqual({ id: "section-1", text: "ادامه", level: 3 });
    expect(html).toContain('<h2 id="intro">مقدمه</h2>');
  });

  it("returns empty headings when the body has none", () => {
    const source = "<p>فقط یک پاراگراف بدون عنوان</p>";
    const { html, headings } = extractBlogHeadings(source);

    expect(headings).toEqual([]);
    expect(html).toBe(source);
  });

  it("skips empty headings and ignores h4", () => {
    const { headings, html } = extractBlogHeadings(
      `<h2>   </h2><h4>جزئیات</h4><h2>عنوان واقعی</h2>`,
    );

    expect(headings).toEqual([{ id: "section-1", text: "عنوان واقعی", level: 2 }]);
    expect(html).toContain("<h4>جزئیات</h4>");
    expect(html).toContain('<h2 id="section-1">عنوان واقعی</h2>');
  });

  it("generates a new id when an existing id is duplicated", () => {
    const { headings } = extractBlogHeadings(
      `<h2 id="same">اول</h2><h2 id="same">دوم</h2>`,
    );

    expect(headings.map((heading) => heading.id)).toEqual(["same", "section-1"]);
  });
});
