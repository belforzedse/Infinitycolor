import type { Strapi } from "@strapi/strapi";

export const MELLAT_ATTEMPT_UID = "api::payment-attempt.payment-attempt" as const;
export const MELLAT_LEASE_MS = 60_000;
export const MELLAT_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000] as const;

export type MellatPhase =
  | "initiating" | "redirected" | "verifying" | "verified" | "settling"
  | "settled" | "reversing" | "reversed" | "completed" | "review";

export type MellatState = {
  version: 1;
  saleOrderId: string;
  amountIrr: number;
  terminalFingerprint: string;
  phase: MellatPhase;
  stockProtected: boolean;
  refId?: string;
  saleReferenceId?: string;
  callbackCode?: string;
  callbackAt?: string;
  processingStartedAt?: string;
  verifiedAt?: string;
  settledAt?: string;
  reversedAt?: string;
  pendingOperation?: "verify" | "settle" | "inquiry" | "reverse";
  retryCount?: number;
  lastCode?: number;
  lastError?: string;
  alertedAt?: string;
  responses?: Partial<Record<"pay" | "verify" | "settle" | "inquiry" | "reverse", {
    at: string;
    resCode?: number;
    rawResCode?: string;
    ambiguous: boolean;
    errorCode?: string;
  }>>;
};

export const isMellatAttempt = (attempt: any): boolean =>
  String(attempt?.Gateway ?? attempt?.gateway ?? "").toLowerCase() === "mellat";

export const readMellatState = (attempt: any): MellatState | null => {
  const state = (attempt?.providerResponse ?? attempt?.provider_response)?.mellat;
  return state?.version === 1 ? state as MellatState : null;
};

export const mellatProviderResponse = (attempt: any, state: MellatState) => ({
  ...(attempt?.providerResponse ?? attempt?.provider_response ?? {}),
  mellat: state,
});

export class MellatPaymentInProgressError extends Error {
  readonly code = "MELLAT_PAYMENT_IN_PROGRESS";
  constructor() {
    super("MELLAT_PAYMENT_IN_PROGRESS");
    this.name = "MellatPaymentInProgressError";
  }
}

/** Caller holds the order lock before taking an attempt lock. */
export async function lockMellatAttempt(strapi: Strapi, attemptId: number, trx: any) {
  await trx.raw("SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE", [attemptId]);
  return strapi.db.query(MELLAT_ATTEMPT_UID).findOne({
    where: { id: attemptId },
    populate: { order: true, contract: true },
    transacting: trx,
  } as any);
}

/** All release paths share this guard; a lease timeout is never financial evidence. */
export async function assertMellatReservationReleasable(
  strapi: Strapi, orderId: number, trx: any,
): Promise<void> {
  await trx.raw("SELECT id FROM orders WHERE id = ? FOR UPDATE", [orderId]);
  const protectedAttempts = await trx.raw(
    `SELECT pa.id, TRUE AS mellat_protected FROM payment_attempts pa
     JOIN payment_attempts_order_links link ON link.payment_attempt_id = pa.id
     WHERE link.order_id = ? AND lower(pa.gateway) = 'mellat'
       AND pa.provider_response->'mellat'->>'stockProtected' = 'true'
     FOR UPDATE OF pa`, [orderId],
  );
  if ((protectedAttempts?.rows || []).some((row: any) => row.mellat_protected === true)) {
    throw new MellatPaymentInProgressError();
  }
}

export const isMellatReservationProtected = (attempt: any): boolean =>
  isMellatAttempt(attempt) && readMellatState(attempt)?.stockProtected === true;

/** A bank page already carries the original payable; edits cannot silently reprice it. */
export async function assertMellatOrderAdjustable(strapi: Strapi, orderId: number, trx: any): Promise<void> {
  await trx.raw("SELECT id FROM orders WHERE id = ? FOR UPDATE", [orderId]);
  const active = await trx.raw(
    `SELECT pa.id, TRUE AS mellat_payment_active FROM payment_attempts pa
     JOIN payment_attempts_order_links link ON link.payment_attempt_id = pa.id
     JOIN orders o ON o.id = link.order_id
     WHERE link.order_id = ? AND lower(pa.gateway) = 'mellat' AND o.status = 'Paying'
       AND (pa.status IN ('Created', 'Pending', 'Redirected', 'Unknown')
         OR pa.provider_response->'mellat'->>'stockProtected' = 'true')
     FOR UPDATE OF pa`, [orderId],
  );
  if ((active?.rows || []).some((row: any) => row.mellat_payment_active === true)) {
    throw new MellatPaymentInProgressError();
  }
}
