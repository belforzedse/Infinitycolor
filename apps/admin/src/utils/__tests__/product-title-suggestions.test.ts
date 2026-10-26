import {
  getProductTitleSuggestions,
  getProductTitleWordAtCursor,
  normalizeProductTitleWord,
  replaceProductTitleWord,
} from "../product-title-suggestions";

describe("normalizeProductTitleWord", () => {
  it("normalizes Arabic letters, diacritics and surrounding spaces", () => {
    expect(normalizeProductTitleWord("  كَتان  ")).toBe("کتان");
    expect(normalizeProductTitleWord("شُوميز")).toBe("شومیز");
  });
});

describe("getProductTitleSuggestions", () => {
  it("suggests words that start with the typed letters", () => {
    expect(
      getProductTitleSuggestions("شو", ["شومیز", "شلوار", "شومیزی", "مانتو"]),
    ).toEqual(["شومیز", "شومیزی"]);
  });

  it("matches Arabic and Persian forms of the same letters", () => {
    expect(getProductTitleSuggestions("كت", ["کتان", "نخی"])).toEqual(["کتان"]);
  });

  it("returns no suggestions for fewer than two letters", () => {
    expect(getProductTitleSuggestions("", ["شومیز"])).toEqual([]);
    expect(getProductTitleSuggestions("ش", ["شومیز"])).toEqual([]);
  });

  it("does not suggest a word that is already complete", () => {
    expect(getProductTitleSuggestions("شومیز", ["شومیز", "شومیزی"])).toEqual([
      "شومیزی",
    ]);
  });

  it("does not match letters in the middle of a word", () => {
    expect(getProductTitleSuggestions("میز", ["شومیز"])).toEqual([]);
  });

  it("returns at most six suggestions", () => {
    const keywords = [
      "شومیز",
      "شومیزی",
      "شور",
      "شورا",
      "شورای",
      "شورایی",
      "شورانگیز",
    ];

    expect(getProductTitleSuggestions("شو", keywords)).toEqual(
      keywords.slice(0, 6),
    );
  });
});
describe("getProductTitleWordAtCursor", () => {
  it("finds the last word being typed", () => {
    const title = "شومیز نخ";

    expect(getProductTitleWordAtCursor(title, title.length)).toEqual({
      word: "نخ",
      start: 6,
      end: 8,
    });
  });

  it("finds a word in the middle of the title", () => {
    const title = "شومیز نخی آبی";
    const cursor = "شومیز نخ".length;

    expect(getProductTitleWordAtCursor(title, cursor)).toEqual({
      word: "نخ",
      start: 6,
      end: 9,
    });
  });

  it("preserves half-spaces inside a word", () => {
    const title = "تی\u200cشرت";

    expect(getProductTitleWordAtCursor(title, title.length)).toEqual({
      word: title,
      start: 0,
      end: title.length,
    });
  });

  it("returns null after a space", () => {
    const title = "شومیز ";

    expect(getProductTitleWordAtCursor(title, title.length)).toBeNull();
  });

  it("returns null for an empty title or a cursor at the beginning", () => {
    expect(getProductTitleWordAtCursor("", 0)).toBeNull();
    expect(getProductTitleWordAtCursor("شومیز", 0)).toBeNull();
  });
});

describe("replaceProductTitleWord", () => {
  it("replaces the current word and preserves the surrounding title", () => {
    const title = "شومیز نخ آبی";
    const range = getProductTitleWordAtCursor(title, "شومیز نخ".length);

    expect(range).not.toBeNull();
    if (!range) throw new Error("Expected a word range");

    expect(replaceProductTitleWord(title, range, "نخی")).toEqual({
      title: "شومیز نخی آبی",
      cursor: "شومیز نخی".length,
    });
  });

  it("replaces the whole word when the cursor is inside it", () => {
    const title = "شومیز نخی آبی";
    const range = getProductTitleWordAtCursor(title, "شومیز نخ".length);

    expect(range).not.toBeNull();
    if (!range) throw new Error("Expected a word range");

    expect(replaceProductTitleWord(title, range, "نخ‌پنبه")).toEqual({
      title: "شومیز نخ‌پنبه آبی",
      cursor: "شومیز نخ‌پنبه".length,
    });
  });
});
