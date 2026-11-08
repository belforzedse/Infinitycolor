import type { Strapi } from "@strapi/strapi";
import { isProductPubliclyVisible, isProductRemoved } from "../../../../utils/productVisibility";
import { getAvailableStockCount } from "../lib/stock";
import {
  findLiveCheckoutHoldForUser,
  resolveEligibleCheckoutHold,
  type CheckoutHold,
  type CheckoutHoldResolution,
} from "../lib/checkout-hold";
import { RESERVATION_LOOKUP_FAILED_RESULT } from "../lib/checkout-resume";

type CartMutationResult = { success?: boolean } | null | undefined;

export type CheckCartStockOptions = {
  /** Exact checkout being resumed. Ownership is validated server-side. */
  attemptId?: string;
};

const mutationSucceeded = (result: CartMutationResult) => result?.success !== false;

const stockIdOf = (item: {
  product_variation?: { product_stock?: { id?: unknown } | null };
}): number => {
  const parsed = Number(item.product_variation?.product_stock?.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};

const availableForCheckout = (
  item: { product_variation?: { product_stock?: unknown } },
  hold: CheckoutHold | null,
) => {
  const free = getAvailableStockCount(item.product_variation?.product_stock);
  const stockId = stockIdOf(item);
  const held = hold && stockId ? hold.quantitiesByStockId.get(stockId) || 0 : 0;
  return free + held;
};

const reservationOutcomeOf = (
  resolution: CheckoutHoldResolution,
): "held" | "expired" | "released" | "ineligible" | "unavailable" | undefined => {
  if (resolution.status === "missing") return undefined;
  if (resolution.status === "held") return "held";
  return resolution.status;
};

export type ResumableCheckout = {
  attemptId: string;
  orderId: number;
  quoteHash: string;
  gateway?: string;
  reservedUntil?: string;
};

const toResumableCheckout = (hold: CheckoutHold | null): ResumableCheckout | null => {
  const attemptId = String(hold?.attemptId || "").trim();
  const quoteHash = String(hold?.quoteHash || "").trim();
  const orderId = hold?.orderId ?? 0;
  if (!attemptId || !quoteHash || !Number.isInteger(orderId) || orderId <= 0) {
    return null;
  }
  const reservedUntil = hold?.reservedUntil;
  return {
    attemptId,
    orderId,
    quoteHash,
    ...(hold?.gateway ? { gateway: hold.gateway } : {}),
    ...(reservedUntil && !Number.isNaN(reservedUntil.getTime())
      ? { reservedUntil: reservedUntil.toISOString() }
      : {}),
  };
};

export type CheckCartStockResult = {
  success: boolean;
  valid: boolean;
  message?: string;
  errorCode?: string;
  reservationOutcome?: "held" | "expired" | "released" | "ineligible" | "unavailable";
  cart?: unknown;
  cartIsEmpty?: boolean;
  itemsRemoved?: unknown[];
  itemsAdjusted?: unknown[];
  heldOrderId?: number;
  resumableCheckout?: ResumableCheckout | null;
};

const lookupFailedResult = (cart: unknown): CheckCartStockResult => ({
  success: false,
  valid: false,
  errorCode: RESERVATION_LOOKUP_FAILED_RESULT.errorCode,
  message: RESERVATION_LOOKUP_FAILED_RESULT.message,
  reservationOutcome: "unavailable",
  cart,
});

export const checkCartStockOp = async (
  strapi: Strapi,
  userId: number,
  options?: CheckCartStockOptions,
): Promise<CheckCartStockResult> => {
  // Same owner requirement as remove/update: without it those ops no-op and the
  // storefront stock-reconcile loop would keep reporting invalid forever.
  if (!Number.isInteger(userId) || userId <= 0) {
    return { success: false, valid: false, message: "Cart owner is required" };
  }

  let holdResolution: CheckoutHoldResolution = { status: "missing" };
  try {
    holdResolution = await resolveEligibleCheckoutHold(strapi, userId, options?.attemptId, { excludeBale: true });
  } catch {
    // Identified continuation: a thrown lookup is not "no reservation".
    holdResolution = String(options?.attemptId || "").trim()
      ? { status: "unavailable" }
      : { status: "missing" };
  }

  const cartService = strapi.service("api::cart.cart");
  if (holdResolution.status === "unavailable") {
    const cart = await cartService.getUserCart(userId);
    return lookupFailedResult(cart);
  }

  let hold: CheckoutHold | null = holdResolution.status === "held" ? holdResolution.hold : null;
  if (!hold) {
    const liveHold = await findLiveCheckoutHoldForUser(strapi, userId);
    if (liveHold.status === "unavailable") {
      // A thrown user-scoped lookup is not "no reservation". Stripping lines
      // here would delete the shopper's own hold when localStorage has no id.
      if (holdResolution.status === "missing") {
        const cart = await cartService.getUserCart(userId);
        return lookupFailedResult(cart);
      }
    } else if (liveHold.status === "held") {
      hold = liveHold.hold;
    }
  }

  const namedOutcome = reservationOutcomeOf(holdResolution);
  const reservationOutcome = namedOutcome ?? (hold ? "held" : undefined);
  const resumableCheckout = toResumableCheckout(hold);
  // Unfiltered: a line whose product left the store is hidden from every other
  // cart read, so this is the only place it can be removed and named.
  const cart = await cartService.getUserCart(userId, { includeUnavailable: true });
  if (!cart.cart_items || cart.cart_items.length === 0) {
    return {
      success: true,
      valid: true,
      message: "Cart is empty",
      cart,
      reservationOutcome,
      heldOrderId: hold?.orderId,
      resumableCheckout,
    };
  }

  const adjustments: any[] = [];
  const removals: any[] = [];
  let mutationFailed = false;

  const removeOwnedItem = async (itemId: number) => {
    const result = await cartService.removeCartItem(itemId, userId);
    if (mutationSucceeded(result)) return true;
    mutationFailed = true;
    return false;
  };

  const updateOwnedItem = async (itemId: number, count: number) => {
    const result = await cartService.updateCartItem(itemId, count, userId);
    if (mutationSucceeded(result)) return true;
    mutationFailed = true;
    return false;
  };

  for (const item of cart.cart_items) {
    const variation = item.product_variation;
    const product = variation?.product;

    // Check if product is soft-deleted or inactive
    if (!isProductPubliclyVisible(product)) {
      if (await removeOwnedItem(item.id)) {
        removals.push({
          cartItemId: item.id,
          productVariationId: variation?.id,
          productTitle: product?.Title,
          message: "Product is no longer available, item removed from cart",
          reason: isProductRemoved(product) ? "soft_deleted" : "inactive",
        });
      }
      continue;
    }

    // Check if variation is unpublished
    if (variation?.IsPublished === false) {
      if (await removeOwnedItem(item.id)) {
        removals.push({
          cartItemId: item.id,
          productVariationId: variation?.id,
          productTitle: product?.Title,
          message:
            "Product variation is no longer available, item removed from cart",
          reason: "unpublished_variation",
        });
      }
      continue;
    }

    if (!item.product_variation?.product_stock) {
      if (await removeOwnedItem(item.id)) {
        removals.push({
          cartItemId: item.id,
          productVariationId: item.product_variation?.id,
          // Carried so the storefront can name a line it can no longer see; the
          // other removal branches already do this and this one silently did not.
          productTitle: product?.Title,
          message:
            "Product stock information not available, item removed from cart",
        });
      }
      continue;
    }
    const available = availableForCheckout(item, hold);
    const requested = Number(item.Count) || 0;
    if (available === 0) {
      if (await removeOwnedItem(item.id)) {
        removals.push({
          cartItemId: item.id,
          productVariationId: item.product_variation.id,
          productTitle: product?.Title,
          requested,
          available: 0,
          message: "Product is out of stock, item removed from cart",
        });
      }
    } else if (available < requested) {
      if (await updateOwnedItem(item.id, available)) {
        adjustments.push({
          cartItemId: item.id,
          productVariationId: item.product_variation.id,
          requested,
          available,
          newQuantity: available,
          message: `Quantity reduced from ${requested} to ${available} due to limited stock`,
        });
      }
    }
  }

  const updatedCart = await cartService.getUserCart(userId);
  const cartIsEmpty =
    !updatedCart.cart_items || updatedCart.cart_items.length === 0;
  // Starting empty is valid (nothing to correct). Empty *after* removals is not:
  // the shopper must be told the cart changed rather than falling through to
  // a generic quote/CART_EMPTY failure on the next step.
  const hadCorrections = removals.length > 0 || adjustments.length > 0;
  return {
    success: true,
    valid: !hadCorrections && !mutationFailed,
    cartIsEmpty,
    itemsRemoved: removals.length > 0 ? removals : undefined,
    itemsAdjusted: adjustments.length > 0 ? adjustments : undefined,
    cart: updatedCart,
    reservationOutcome,
    heldOrderId: hold?.orderId,
    resumableCheckout,
  };
};
