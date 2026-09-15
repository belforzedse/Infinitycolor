import { extractErrorMessage } from "@/lib/errorTranslations";

/**
 * Shown when the shopper's own click asked for more than is available. This is
 * click-site feedback, so it stays a toast; a cart the *server* changed on its
 * own is reported by `CART_STOCK_NOTICE_MESSAGE` instead.
 */
export const CART_STOCK_LIMIT_MESSAGE = "موجودی بیشتری از این کالا در دسترس نیست.";

/** The one line shown when stock moved underneath a cart the shopper already had. */
export const CART_STOCK_NOTICE_MESSAGE = "موجودی برخی اقلام تغییر کرد و سبد خرید شما به‌روز شد.";

/**
 * A cart the server corrected without the shopper asking. Adjusted lines are
 * still in the cart (marked in place by their `cartItemId`); removed ones are
 * gone, so their names have to be named or the items just vanish.
 */
export interface CartStockNoticeState {
  adjustedCartItemIds: string[];
  removedNames: string[];
}

export const buildCartStockNoticeText = (notice: CartStockNoticeState): string => {
  if (notice.removedNames.length === 0) return CART_STOCK_NOTICE_MESSAGE;
  return `${CART_STOCK_NOTICE_MESSAGE} ${notice.removedNames.join("، ")} ناموجود شد و از سبد حذف شد.`;
};

export const isCartStockLimitError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;

  const candidate = error as {
    errorCode?: unknown;
    data?: { errorCode?: unknown };
  };
  const errorCode = candidate.errorCode ?? candidate.data?.errorCode;
  if (errorCode === "CART_STOCK_EXCEEDED") return true;

  const message = extractErrorMessage(error).toLowerCase();
  return message.includes("not enough stock") || message.includes("insufficient stock");
};
