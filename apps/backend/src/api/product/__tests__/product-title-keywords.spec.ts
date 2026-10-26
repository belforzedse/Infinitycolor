import type { Strapi } from "@strapi/strapi";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractProductKeywords, rebuildProductKeywords } from "../services/product-title-keywords";

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
describe("rebuildProductKeywords", () => {
  it("writes the dictionary and preserves it when a later rebuild fails", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "infinity-keywords-test-"));

    const findMany = jest.fn().mockResolvedValue([
      { id: 1, Title: "شومیز نخی آبی" },
      { id: 2, Title: "شومیز لینن سفید" },
    ]);

    const fakeStrapi = {
      dirs: {
        app: { root: temporaryRoot },
      },
      db: {
        query: jest.fn(() => ({ findMany })),
      },
    } as unknown as Strapi;

    try {
      const filePath = await rebuildProductKeywords(fakeStrapi);

      expect(filePath).toBe(path.join(temporaryRoot, ".tmp", "product-title-keywords.json"));

      const savedText = await readFile(filePath, "utf8");
      const savedData = JSON.parse(savedText);

      expect(savedData).toEqual({
        version: 1,
        generatedAt: expect.any(String),
        keywords: ["شومیز", "نخی", "آبی", "لینن", "سفید"],
      });

      findMany.mockRejectedValueOnce(new Error("Database unavailable"));

      await expect(rebuildProductKeywords(fakeStrapi)).rejects.toThrow("Database unavailable");

      expect(await readFile(filePath, "utf8")).toBe(savedText);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
