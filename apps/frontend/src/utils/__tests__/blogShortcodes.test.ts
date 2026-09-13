import {
  parseBlogBlocks,
  parseProductShortcodes,
  type ProductsBlock,
  type PromoBlock,
} from "@/utils/blogShortcodes";

/**
 * The renderer slices the article around each block's indices, so an index that
 * is off by even one character puts `[products:…]` on the page as literal text —
 * which is what three live posts show today.
 */
function sliceOut(html: string, block: { startIndex: number; endIndex: number }) {
  return html.slice(block.startIndex, block.endIndex);
}

describe("parseBlogBlocks", () => {
  it("returns indices into the original string, entities and all", () => {
    const html =
      '<p>پارچه &amp; دوخت</p>\n[products:"shal-nakhi",12]\n<p>ادامه &nbsp; مطلب</p>';
    const [block] = parseBlogBlocks(html) as ProductsBlock[];
    expect(block.type).toBe("products");
    expect(block.identifiers).toEqual(["shal-nakhi", "12"]);
    expect(sliceOut(html, block)).toBe('[products:"shal-nakhi",12]');
    // The surrounding article survives the split unchanged.
    expect(html.slice(0, block.startIndex)).toBe("<p>پارچه &amp; دوخت</p>\n");
    expect(html.slice(block.endIndex)).toBe("\n<p>ادامه &nbsp; مطلب</p>");
  });

  it("parses a marker the editor stored with encoded quotes", () => {
    const html = "<p>متن</p>[products:&quot;shal-nakhi&quot;,&quot;kif&quot;]<p>ادامه</p>";
    const [block] = parseBlogBlocks(html) as ProductsBlock[];
    expect(block.identifiers).toEqual(["shal-nakhi", "kif"]);
    expect(sliceOut(html, block)).toBe("[products:&quot;shal-nakhi&quot;,&quot;kif&quot;]");
  });

  it("parses a fully entity-encoded marker", () => {
    const html = "<p>متن</p>&#91;products:12,13&#93;";
    const [block] = parseBlogBlocks(html) as ProductsBlock[];
    expect(block.identifiers).toEqual(["12", "13"]);
    expect(sliceOut(html, block)).toBe("&#91;products:12,13&#93;");
  });

  it("keeps Persian slugs and does not cap the number of products", () => {
    const slugs = Array.from({ length: 16 }, (_, index) => `شلوار-جین-${index}`);
    const html = `[products:${slugs.map((slug) => `"${slug}"`).join(",")}]`;
    const [block] = parseBlogBlocks(html) as ProductsBlock[];
    expect(block.identifiers).toEqual(slugs);
  });

  it("treats a comma inside quotes as part of the slug", () => {
    const [block] = parseBlogBlocks('[products:"shal,nakhi","kif"]') as ProductsBlock[];
    expect(block.identifiers).toEqual(["shal,nakhi", "kif"]);
  });

  it("finds every block in document order", () => {
    const html = '<p>a</p>[products:1]<p>b</p>[products:2,3]<p>c</p>';
    const blocks = parseBlogBlocks(html) as ProductsBlock[];
    expect(blocks.map((block) => block.identifiers)).toEqual([["1"], ["2", "3"]]);
    expect(blocks[0].startIndex).toBeLessThan(blocks[1].startIndex);
    expect(sliceOut(html, blocks[1])).toBe("[products:2,3]");
  });

  it("parses a promo block whose JSON contains a closing bracket", () => {
    const html =
      '<p>متن</p>[promo:{"v":1,"title":"مانتوهای ما [ویژه]","body":"زیبایی و مد","cta":{"label":"مشاهده محصولات","href":"/plp/category/coat-and-mantle"},"social":{"label":"Infinity.color_boutique","href":"https://instagram.com/infinity.color_boutique"},"image":{"url":"/uploads/blog-temp-pic1.png","alt":""},"variant":"pic1"}]<p>ادامه</p>';
    const [block] = parseBlogBlocks(html) as PromoBlock[];
    expect(block.type).toBe("promo");
    expect(block.data.title).toBe("مانتوهای ما [ویژه]");
    expect(block.data.cta).toEqual({
      label: "مشاهده محصولات",
      href: "/plp/category/coat-and-mantle",
    });
    expect(block.data.social?.href).toBe("https://instagram.com/infinity.color_boutique");
    expect(block.data.image).toEqual({ url: "/uploads/blog-temp-pic1.png", alt: "" });
    expect(block.data.variant).toBe("pic1");
    expect(html.slice(block.endIndex)).toBe("<p>ادامه</p>");
  });

  it("drops an unsafe href instead of rendering it", () => {
    const [block] = parseBlogBlocks(
      '[promo:{"title":"t","body":"b","cta":{"label":"x","href":"javascript:alert(1)"},"social":{"label":"y","href":"//evil.example"}}]',
    ) as PromoBlock[];
    expect(block.data.cta).toBeNull();
    expect(block.data.social).toBeNull();
    expect(block.data.title).toBe("t");
  });

  it("leaves malformed markers in the article rather than swallowing them", () => {
    expect(parseBlogBlocks("[products:]")).toEqual([]);
    expect(parseBlogBlocks("[products:1")).toEqual([]);
    expect(parseBlogBlocks('[promo:{"title":]')).toEqual([]);
    expect(parseBlogBlocks("[promo:{}]")).toEqual([]);
    // A marker interrupted by a tag is not a marker.
    expect(parseBlogBlocks("[products:<b>1</b>]")).toEqual([]);
  });

  it("ignores content that merely mentions a marker-like word", () => {
    expect(parseBlogBlocks("<p>درباره products: و promo:</p>")).toEqual([]);
    expect(parseBlogBlocks("")).toEqual([]);
    expect(parseBlogBlocks(null as unknown as string)).toEqual([]);
  });

  it("parseProductShortcodes still sees only carousels", () => {
    const html = '[products:1][promo:{"title":"t","body":"b"}]';
    expect(parseProductShortcodes(html).map((block) => block.type)).toEqual(["products"]);
    expect(parseBlogBlocks(html)).toHaveLength(2);
  });

  it("finds a marker that follows heading ids injected before parsing", () => {
    // The article page rewrites headings (adding id attributes) before the body
    // is parsed; the marker's offsets must come from that rewritten string.
    const html = '<h2 id="section-1">عنوان</h2>[products:"shal-nakhi"]';
    const [block] = parseBlogBlocks(html) as ProductsBlock[];
    expect(sliceOut(html, block)).toBe('[products:"shal-nakhi"]');
  });
});
