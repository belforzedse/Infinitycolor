import { useCallback } from "react";

import { trackAnalyticsEvent } from "@/lib/analytics";
import { scrollIntoViewWithOffset } from "@/utils/scroll";

/**
 * Shared handler for every control that takes a shopper to the product review
 * section — the "دیدگاه‌ها" action and the review-count link above it.
 *
 * The count previously looked like a link but carried no handler at all, so the
 * advertised shortcut did nothing while a sibling button did the real work.
 * Keeping one implementation means both entry points scroll to the same anchor
 * and report the same event.
 */
export function useScrollToComments(productId: string) {
  return useCallback(() => {
    trackAnalyticsEvent({
      category: "engagement",
      action: "open_comments",
      properties: { product_id: productId },
      onceKey: `open-comments:${productId}`,
    });

    const commentsSection = document.querySelector<HTMLElement>("[data-comments-section]");

    if (commentsSection) {
      scrollIntoViewWithOffset(commentsSection);
      return;
    }

    // Older markup had no data attribute; keep the structural fallback.
    const pdpCommentElement = document.querySelector<HTMLElement>(
      ".flex.gap-4.flex-col-reverse.md\\:flex-row",
    );

    if (pdpCommentElement) {
      scrollIntoViewWithOffset(pdpCommentElement);
    }
  }, [productId]);
}
