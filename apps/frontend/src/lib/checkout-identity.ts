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

/** Server-confirmed live Paying reservation that may be replayed. */
export type ResumableCheckoutIdentity = {
  attemptId: string;
  quoteHash: string;
  orderId?: number | string;
  gateway?: string;
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

/**
 * Restore the live Paying checkout from the server when the browser has lost
 * (or never had) matching localStorage keys. A different stored unpaid order
 * is stashed as continuable instead of being dropped.
 */
export function hydrateCheckoutIdentityFromServer(
  resumable: ResumableCheckoutIdentity | null | undefined,
): CheckoutIdentity | null {
  const attemptId = String(resumable?.attemptId || "").trim();
  const quoteHash = String(resumable?.quoteHash || "").trim();
  if (!attemptId || !quoteHash) return null;

  const next: CheckoutIdentity = {
    attemptId,
    quoteHash,
    orderId: String(resumable?.orderId || "").trim() || undefined,
    gateway: String(resumable?.gateway || "").trim() || undefined,
  };
  const existing = readCheckoutIdentity();
  if (existing?.attemptId === next.attemptId && existing.quoteHash === next.quoteHash) {
    const merged: CheckoutIdentity = {
      ...existing,
      orderId: existing.orderId || next.orderId,
      gateway: existing.gateway || next.gateway,
    };
    writeCheckoutIdentity(merged);
    return merged;
  }
  if (existing?.orderId && existing.attemptId && existing.attemptId !== next.attemptId) {
    writeContinuableIdentity(existing);
  }
  writeCheckoutIdentity(next);
  return next;
}

export function readCheckoutAttemptId(): string | undefined {
  return readCheckoutIdentity()?.attemptId || readKey(CHECKOUT_ATTEMPT_STORAGE_KEY) || undefined;
}

const newAttemptId = () =>
  globalThis.crypto?.randomUUID?.() ||
  `checkout-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function checkoutGatewaysMatch(stored?: string, selected?: string): boolean {
  const a = String(stored || "").trim().toLowerCase();
  const b = String(selected || "").trim().toLowerCase();
  if (!a || !b) return true;
  return a === b;
}

/**
 * Resume the original payment only when the server still holds a live Paying
 * reservation whose quote matches the stored identity. An empty cart alone is
 * not enough — that used to replay leftover localStorage after the hold died.
 */
export function shouldResumeStoredCheckout(input: {
  stored: CheckoutIdentity | null | undefined;
  selectedGateway?: string;
  selectableGateways?: string[];
  cartIsEmpty: boolean;
  continuation?: boolean;
  resumableCheckout?: ResumableCheckoutIdentity | null;
}): boolean {
  const stored = input.stored;
  if (!stored?.attemptId || !stored.quoteHash) return false;
  if (input.continuation) return true;
  if (!input.cartIsEmpty) return false;

  const live = input.resumableCheckout;
  if (!live?.attemptId || !live.quoteHash) return false;
  if (stored.attemptId !== live.attemptId) return false;
  if (stored.quoteHash !== live.quoteHash) return false;

  if (checkoutGatewaysMatch(stored.gateway, input.selectedGateway)) return true;
  const storedGateway = String(stored.gateway || "").trim().toLowerCase();
  const selectedGateway = String(input.selectedGateway || "").trim().toLowerCase();
  const selectable = (input.selectableGateways || []).map((code) =>
    String(code || "").trim().toLowerCase(),
  );
  const canPickStored = Boolean(storedGateway && selectable.includes(storedGateway));
  const canPickSelected = Boolean(selectedGateway && selectable.includes(selectedGateway));
  // Both methods are on the radio: this is a deliberate gateway change.
  if (canPickStored && canPickSelected && storedGateway !== selectedGateway) return false;
  return true;
}

export type ResolvedCheckoutAttempt = {
  attemptId: string;
  quoteHash: string;
  gateway?: string;
  continueExisting: boolean;
  /**
   * The stored attempt this one was minted over, when a new id was minted.
   *
   * Changing a coupon, a shipping method or a wallet amount produces a new
   * quote and therefore a new attempt, which would otherwise leave the
   * shopper's own wallet credit and stock committed to the attempt they just
   * walked away from. Naming it lets the server hand both back. The server
   * validates ownership and refuses anything a provider has already seen.
   */
  supersedesAttemptId?: string;
};

/**
 * Resume the original payment only when the payable quote and gateway match, or
 * the cart was emptied by a hold on that same gateway. A different quote
 * (coupon, shipping, total) or gateway is a new purchase. Matching a stashed
 * continuable identity restores the original unpaid checkout instead of minting
 * a third attempt.
 */
export function resolveCheckoutAttemptId(input: {
  quoteHash: string;
  cartSignature: string;
  cartIsEmpty: boolean;
  gateway?: string;
}): ResolvedCheckoutAttempt {
  const quoteHash = String(input.quoteHash || "").trim();
  const existing = readCheckoutIdentity();
  const existingGatewayMatches = checkoutGatewaysMatch(existing?.gateway, input.gateway);

  if (
    existing &&
    existingGatewayMatches &&
    (input.cartIsEmpty || existing.quoteHash === quoteHash)
  ) {
    return {
      attemptId: existing.attemptId,
      quoteHash: existing.quoteHash,
      gateway: existing.gateway || input.gateway,
      continueExisting: true,
    };
  }

  const continuable = readContinuableCheckoutIdentity();
  if (
    continuable &&
    checkoutGatewaysMatch(continuable.gateway, input.gateway) &&
    (continuable.quoteHash === quoteHash || input.cartIsEmpty)
  ) {
    writeCheckoutIdentity(continuable);
    return {
      attemptId: continuable.attemptId,
      quoteHash: continuable.quoteHash,
      gateway: continuable.gateway || input.gateway,
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
    supersedesAttemptId: existing?.attemptId || undefined,
  };
}
