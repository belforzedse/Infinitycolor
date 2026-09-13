import { extractErrorMessage } from "@/lib/errorTranslations";

export const CART_STOCK_LIMIT_MESSAGE = "موجودی بیشتری از این کالا در دسترس نیست.";

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
