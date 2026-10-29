export function normalizeProductTitleWord(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .toLowerCase()
    .trim();
}

export function getProductTitleSuggestions(
  word: string,
  keywords: readonly string[],
): string[] {
  const normalizedWord = normalizeProductTitleWord(word);

  if (normalizedWord.length < 2) {
    return [];
  }

  return keywords
    .filter((keyword) => {
      const normalizedKeyword = normalizeProductTitleWord(keyword);

      return (
        normalizedKeyword.startsWith(normalizedWord) &&
        normalizedKeyword !== normalizedWord
      );
    })
    .slice(0, 6);
}
export interface ProductTitleWordRange {
  word: string;
  start: number;
  end: number;
}

export function getProductTitleWordAtCursor(
  title: string,
  cursor: number,
): ProductTitleWordRange | null {
  const position = Math.max(0, Math.min(cursor, title.length));

  const matches = title.matchAll(/[\p{L}\p{M}\p{N}\u200c]+/gu);

  for (const match of matches) {
    const start = match.index;
    const end = start + match[0].length;

    if (position > start && position <= end) {
      return {
        word: title.slice(start, position),
        start,
        end,
      };
    }
  }

  return null;
}
export function replaceProductTitleWord(
  title: string,
  range: ProductTitleWordRange,
  suggestion: string,
): { title: string; cursor: number } {
  return {
    title: title.slice(0, range.start) + suggestion + title.slice(range.end),
    cursor: range.start + suggestion.length,
  };
}
