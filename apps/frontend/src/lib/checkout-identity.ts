export const CHECKOUT_ATTEMPT_STORAGE_KEY = "pendingCheckoutAttemptId";
export const CHECKOUT_QUOTE_STORAGE_KEY = "pendingCheckoutQuoteHash";
export const CHECKOUT_ORDER_STORAGE_KEY = "pendingCheckoutOrderId";
export const CHECKOUT_GATEWAY_STORAGE_KEY = "pendingCheckoutGateway";
export const CHECKOUT_SIGNATURE_STORAGE_KEY = "pendingCheckoutCartSignature";
export const CONTINUABLE_ATTEMPT_STORAGE_KEY = "continuableCheckoutAttemptId";
export const CONTINUABLE_QUOTE_STORAGE_KEY = "continuableCheckoutQuoteHash";
export const CONTINUABLE_ORDER_STORAGE_KEY = "continuableCheckoutOrderId";
export const CONTINUABLE_GATEWAY_STORAGE_KEY = "continuableCheckoutGateway";

export type CheckoutIdentity = {
  attemptId: string;
  quoteHash: string;
  orderId?: string;
  gateway?: string;
  cartSignature?: string;
};

const readKey = (key: string): string => {
  if (typeof window === "undefined") return "";
  try {
    return String(window.localStorage.getItem(key) || "").trim();
  } catch {
    return "";
  }
};

const writeKey = (key: string, value: string | undefined) => {
  if (typeof window === "undefined") return;
  try {
    if (!value) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing / hardened modes can throw; callers fall through.
  }
};

const identityFromKeys = (
  attemptKey: string,
  quoteKey: string,
  orderKey: string,
  gatewayKey: string,
  signatureKey?: string,
): CheckoutIdentity | null => {
  const attemptId = readKey(attemptKey);
  const quoteHash = readKey(quoteKey);
  if (!attemptId || !quoteHash) return null;
  const orderId = readKey(orderKey) || undefined;
  const gateway = readKey(gatewayKey) || undefined;
  const cartSignature = signatureKey ? readKey(signatureKey) || undefined : undefined;
  return { attemptId, quoteHash, orderId, gateway, cartSignature };
};

export function readCheckoutIdentity(): CheckoutIdentity | null {
  return identityFromKeys(
    CHECKOUT_ATTEMPT_STORAGE_KEY,
    CHECKOUT_QUOTE_STORAGE_KEY,
    CHECKOUT_ORDER_STORAGE_KEY,
    CHECKOUT_GATEWAY_STORAGE_KEY,
    CHECKOUT_SIGNATURE_STORAGE_KEY,
  );
}

export function readContinuableCheckoutIdentity(): CheckoutIdentity | null {
  return identityFromKeys(
    CONTINUABLE_ATTEMPT_STORAGE_KEY,
    CONTINUABLE_QUOTE_STORAGE_KEY,
    CONTINUABLE_ORDER_STORAGE_KEY,
    CONTINUABLE_GATEWAY_STORAGE_KEY,
  );
}

export function writeCheckoutIdentity(identity: CheckoutIdentity): void {
  writeKey(CHECKOUT_ATTEMPT_STORAGE_KEY, identity.attemptId);
  writeKey(CHECKOUT_QUOTE_STORAGE_KEY, identity.quoteHash);
  writeKey(CHECKOUT_ORDER_STORAGE_KEY, identity.orderId);
  writeKey(CHECKOUT_GATEWAY_STORAGE_KEY, identity.gateway);
  writeKey(CHECKOUT_SIGNATURE_STORAGE_KEY, identity.cartSignature);
}

function writeContinuableIdentity(identity: CheckoutIdentity): void {
  writeKey(CONTINUABLE_ATTEMPT_STORAGE_KEY, identity.attemptId);
  writeKey(CONTINUABLE_QUOTE_STORAGE_KEY, identity.quoteHash);
  writeKey(CONTINUABLE_ORDER_STORAGE_KEY, identity.orderId);
  writeKey(CONTINUABLE_GATEWAY_STORAGE_KEY, identity.gateway);
}

export function clearCheckoutIdentity(): void {
  writeKey(CHECKOUT_ATTEMPT_STORAGE_KEY, undefined);
  writeKey(CHECKOUT_QUOTE_STORAGE_KEY, undefined);
  writeKey(CHECKOUT_ORDER_STORAGE_KEY, undefined);
  writeKey(CHECKOUT_GATEWAY_STORAGE_KEY, undefined);
  writeKey(CHECKOUT_SIGNATURE_STORAGE_KEY, undefined);
}

export function clearContinuableCheckoutIdentity(): void {
  writeKey(CONTINUABLE_ATTEMPT_STORAGE_KEY, undefined);
  writeKey(CONTINUABLE_QUOTE_STORAGE_KEY, undefined);
  writeKey(CONTINUABLE_ORDER_STORAGE_KEY, undefined);
  writeKey(CONTINUABLE_GATEWAY_STORAGE_KEY, undefined);
}

export function persistCheckoutOrder(orderId: number | string | undefined): void {
  const id = String(orderId || "").trim();
  if (!id) return;
  const existing = readCheckoutIdentity();
  if (!existing) {
    writeKey(CHECKOUT_ORDER_STORAGE_KEY, id);
    return;
  }
  writeCheckoutIdentity({ ...existing, orderId: id });
}

export function readCheckoutAttemptId(): string | undefined {
  return readCheckoutIdentity()?.attemptId || readKey(CHECKOUT_ATTEMPT_STORAGE_KEY) || undefined;
}

const newAttemptId = () =>
  globalThis.crypto?.randomUUID?.() ||
  `checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export type ResolvedCheckoutAttempt = {
  attemptId: string;
  quoteHash: string;
  gateway?: string;
  continueExisting: boolean;
};

/**
 * Resume the original payment only when the cart was emptied by a hold, or the
 * payable quote is unchanged. A new total (coupon, shipping, gateway) is a new
 * SnapPay/checkout attempt — the previous unpaid order is left in place so a
 * second delivery of the same items can still be paid separately.
 */
export function resolveCheckoutAttemptId(input: {
  quoteHash: string;
  cartSignature: string;
  cartIsEmpty: boolean;
  gateway?: string;
}): ResolvedCheckoutAttempt {
  const quoteHash = String(input.quoteHash || "").trim();
  const existing = readCheckoutIdentity();

  if (existing && (input.cartIsEmpty || existing.quoteHash === quoteHash)) {
    return {
      attemptId: existing.attemptId,
      quoteHash: existing.quoteHash,
      gateway: existing.gateway || input.gateway,
      continueExisting: true,
    };
  }

  if (existing?.orderId && existing.attemptId) {
    writeContinuableIdentity(existing);
  }

  const attemptId = newAttemptId();
  if (quoteHash) {
    writeCheckoutIdentity({
      attemptId,
      quoteHash,
      gateway: input.gateway,
      cartSignature: input.cartSignature,
    });
  }
  return {
    attemptId,
    quoteHash,
    gateway: input.gateway,
    continueExisting: false,
  };
}
