import type { Strapi } from "@strapi/strapi";
import { extractProductKeywords, fetchProductTitles } from "../services/product-title-keywords";

describe("extractProductKeywords", () => {
  it("extracts words and removes duplicates", () => {
    const result = extractProductKeywords(["شومیز نخی آبی", "شومیز لینن سفید"]);

    expect(result).toEqual(["شومیز", "نخی", "آبی", "لینن", "سفید"]);
  });

  it("normalizes Arabic letters and removes diacritics and common words", () => {
    const result = extractProductKeywords(["شُوميز كتان و نَخی"]);

    expect(result).toEqual(["شومیز", "کتان", "نخی"]);
  });

  it("preserves half-spaces and ignores numbers and punctuation", () => {
    const result = extractProductKeywords(["تی\u200cشرت ۱۲۳ !!!"]);

    expect(result).toEqual(["تی\u200cشرت"]);
  });

  it("returns an empty array when there are no words", () => {
    expect(extractProductKeywords([])).toEqual([]);
    expect(extractProductKeywords(["۱۲۳ !!!"])).toEqual([]);
  });
});
describe("fetchProductTitles", () => {
  it("reads all title batches by id without limiting staff visibility to active products", async () => {
    const firstBatch = Array.from({ length: 500 }, (_, index) => ({
      id: index + 1,
      Title: ` عنوان ${index} `,
    }));
    const findMany = jest
      .fn()
      .mockResolvedValueOnce(firstBatch)
      .mockResolvedValueOnce([
        { id: 900, Title: "شومیز" },
        { id: 901, Title: null },
        { id: 902, Title: "  " },
      ]);
    const query = jest.fn(() => ({ findMany }));
    const strapi = { db: { query } } as unknown as Strapi;

    const titles = await fetchProductTitles(strapi);

    expect(titles).toEqual([...firstBatch.map(({ Title }) => Title.trim()), "شومیز"]);
    expect(query).toHaveBeenCalledWith("api::product.product");
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenNthCalledWith(1, {
      select: ["id", "Title"],
      where: {
        id: { $gt: 0 },
        removedAt: { $null: true },
        purgedAt: { $null: true },
      },
      orderBy: { id: "asc" },
      limit: 500,
    });
    expect(findMany).toHaveBeenNthCalledWith(2, {
      select: ["id", "Title"],
      where: {
        id: { $gt: 500 },
        removedAt: { $null: true },
        purgedAt: { $null: true },
      },
      orderBy: { id: "asc" },
      limit: 500,
    });
  });

  it("stops when the next batch is empty", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const strapi = { db: { query: () => ({ findMany }) } } as unknown as Strapi;

    await expect(fetchProductTitles(strapi)).resolves.toEqual([]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
