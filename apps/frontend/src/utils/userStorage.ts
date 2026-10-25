import { apiCache } from "@/lib/api-cache";

/**
 * Remove state that belongs to one authenticated identity. The guest cart is
 * deliberately retained so it can be migrated after a successful login.
 */
export function clearUserStorage(): void {
  if (typeof window === "undefined") return;

  try {
    for (const key of [
      "discountCode",
      "recentSearches",
      "offline-queue",
      "pendingCheckoutAttemptId",
      "pendingCheckoutQuoteHash",
      "pendingCheckoutOrderId",
      "pendingCheckoutGateway",
      "pendingCheckoutCartSignature",
      "pendingCheckoutFinalization",
      "continuableCheckoutAttemptId",
      "continuableCheckoutQuoteHash",
      "continuableCheckoutOrderId",
      "continuableCheckoutGateway",
      "pendingPaymentAttemptId",
      "pendingOrderId",
      "pendingRefId",
    ]) {
      localStorage.removeItem(key);
    }

    sessionStorage.removeItem("tempPreInvoiceOrder");

    const orderDetailKeys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith("infinity:order-detail:")) {
        orderDetailKeys.push(key);
      }
    }
    orderDetailKeys.forEach((key) => sessionStorage.removeItem(key));

    if (apiCache && typeof apiCache.clearByPattern === "function") {
      for (const pattern of [
        /\/api\/users\//i,
        /\/api\/local-user\//i,
        /\/api\/orders\//i,
        /\/api\/carts\//i,
        /\/api\/wallet\//i,
        /\/api\/product-likes\//i,
        /\/api\/local-user-addresses\//i,
      ]) {
        apiCache.clearByPattern(pattern);
      }
    }
  } catch (error) {
    // Storage can be disabled in private browsing or hardened browser modes.
    console.warn("[Auth] Unable to clear some user-local state:", error);
  }
}
