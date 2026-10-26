export const PRODUCT_TITLE_KEYWORDS_CHANGED = "product-title-keywords-changed";

export function notifyProductTitleKeywordsChanged(): void {
  if (typeof window === "undefined") return;

  window.dispatchEvent(new Event(PRODUCT_TITLE_KEYWORDS_CHANGED));
}
