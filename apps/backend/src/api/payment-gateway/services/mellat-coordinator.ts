import type { Strapi } from "@strapi/strapi";
import * as Sentry from "@sentry/node";
import { enqueueMellatAttempt } from "../../../queue/mellat";
import { mellatTerminalFingerprint } from "./mellat-v3";
import { cancelOrderAndRelease } from "../../cart/controllers/handlers/gateway-helpers";
import { finalizeGatewaySettlement } from "../../order/controllers/helpers/gatewaySettlement";
import {
  MELLAT_ATTEMPT_UID, MELLAT_LEASE_MS, MELLAT_RETRY_DELAYS_MS,
  lockMellatAttempt, mellatProviderResponse, readMellatState, type MellatState,
} from "./mellat-state";

const ORDER_UID = "api::order.order" as const;
const idOf = (relation: any): number => Number(relation?.id ?? relation);
const nowIso = () => new Date().toISOString();
// Retain each operation's latest bank evidence without SOAP envelopes or credentials.
const responseEvidence = (state: MellatState, operation: keyof NonNullable<MellatState["responses"]>, response: any) => ({
  ...state.responses,
  [operation]: {
    at: nowIso(), ambiguous: response?.ambiguous === true,
    ...(Number.isSafeInteger(response?.resCode) ? { resCode: response.resCode } : {}),
    ...(typeof response?.rawResCode === "string" && /^\d{1,16}$/.test(response.rawResCode)
      ? { rawResCode: response.rawResCode } : {}),
    ...(typeof response?.errorCode === "string" && /^[A-Z0-9_]{1,80}$/.test(response.errorCode)
      ? { errorCode: response.errorCode } : {}),
  },
});
const numericId = (value: unknown): string | null => {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  const raw = String(value ?? "");
  return /^[1-9]\d{0,18}$/.test(raw) && BigInt(raw) <= BigInt("9223372036854775807") ? raw : null;
};

async function inAttemptTransaction<T>(
  strapi: Strapi, id: number, fn: (attempt: any, trx: any) => Promise<T>,
): Promise<T | null> {
  const initial: any = await strapi.db.query(MELLAT_ATTEMPT_UID).findOne({
    where: { id, Gateway: "mellat" }, populate: { order: true },
  } as any);
  const orderId = idOf(initial?.order);
  if (!orderId) return null;
  return strapi.db.transaction(async ({ trx }) => {
    await trx.raw("SELECT id FROM orders WHERE id = ? FOR UPDATE", [orderId]);
    const attempt: any = await lockMellatAttempt(strapi, id, trx);
    if (!attempt || String(attempt.Gateway).toLowerCase() !== "mellat") return null;
    return fn(attempt, trx);
  });
}

async function save(strapi: Strapi, attempt: any, state: MellatState, data: any, trx: any) {
  return strapi.db.query(MELLAT_ATTEMPT_UID).update({
    where: { id: attempt.id },
    data: { ...data, providerResponse: mellatProviderResponse(attempt, state) },
    transacting: trx,
  } as any);
}

async function enqueueSafely(strapi: Strapi, id: number, delay = 0) {
  try { await enqueueMellatAttempt(id, delay); }
  catch (error) {
    // nextActionAt was committed first; the minute sweep is the durable fallback.
    strapi.log.error("Mellat recovery enqueue failed; durable sweep will retry", { attemptId: id });
  }
}

export async function prepareMellatInitiation(
  strapi: Strapi, attemptId: number, orderId: number, amountIrr: number,
) {
  if (!Number.isSafeInteger(amountIrr) || amountIrr <= 0) throw new Error("MELLAT_INVALID_AMOUNT");
  return inAttemptTransaction(strapi, attemptId, async (attempt, trx) => {
    if (idOf(attempt.order) !== orderId || attempt.Status !== "Pending") {
      throw new Error("MELLAT_INITIATION_NOT_CLAIMED");
    }
    const state: MellatState = {
      version: 1, saleOrderId: String(orderId), amountIrr,
      terminalFingerprint: mellatTerminalFingerprint(), phase: "initiating", stockProtected: false,
    };
    await save(strapi, attempt, state, {}, trx);
    return state;
  });
}

export async function recordMellatInitiation(strapi: Strapi, attemptId: number, result: any) {
  await inAttemptTransaction(strapi, attemptId, async (attempt, trx) => {
    const state = readMellatState(attempt);
    if (!state) throw new Error("MELLAT_INITIATION_STATE_MISSING");
    const success = result?.success === true && typeof result.refId === "string" && result.refId.length > 0;
    await save(strapi, attempt, {
      ...state, phase: success ? "redirected" : "review", refId: success ? result.refId : undefined,
      lastCode: result?.resCode, lastError: success ? undefined : result?.errorCode,
      responses: responseEvidence(state, "pay", result),
    }, {
      ...(success ? {
        providerReference: result.refId, redirectUrl: result.redirectUrl, redirectedAt: new Date(),
        // Follow up a missing browser return; this is not an assumed bank-token expiry.
        nextAction: "mellat_reconcile", nextActionAt: new Date(Date.now() + 15 * 60_000),
      } : {}),
    }, trx);
  });
}

/** The callback is evidence to check, never authorization to fulfill an order. */
export async function acceptMellatCallback(strapi: Strapi, body: Record<string, unknown>) {
  const refId = typeof body.RefId === "string" && !/\s/.test(body.RefId) ? body.RefId : "";
  const saleOrderId = numericId(body.SaleOrderId);
  const code = String(body.ResCode ?? "").trim();
  if (!refId || !saleOrderId || !/^\d{1,4}$/.test(code)) throw new Error("MELLAT_CALLBACK_INVALID");
  const found: any = await strapi.db.query(MELLAT_ATTEMPT_UID).findOne({
    where: { Gateway: "mellat", providerReference: refId }, populate: { order: true },
  } as any);
  if (!found) throw new Error("MELLAT_CALLBACK_UNCORRELATED");
  const result = await inAttemptTransaction(strapi, Number(found.id), async (attempt, trx) => {
    const state = readMellatState(attempt);
    if (!state || state.refId !== refId || state.saleOrderId !== saleOrderId ||
        (body.OrderId != null && numericId(body.OrderId) !== saleOrderId)) {
      throw new Error("MELLAT_CALLBACK_REFERENCE_MISMATCH");
    }
    const saleReferenceId = numericId(body.SaleReferenceId);
    if (code === "0" && !saleReferenceId) throw new Error("MELLAT_CALLBACK_REFERENCE_MISSING");
    if (state.saleReferenceId && saleReferenceId && state.saleReferenceId !== saleReferenceId) {
      throw new Error("MELLAT_CALLBACK_REFERENCE_MISMATCH");
    }
    if (attempt.Status === "Succeeded") return { orderId: idOf(attempt.order), status: "Succeeded", attemptId: Number(attempt.id) };
    if (state.phase === "reversed" && state.reversedAt && attempt.Status === "Cancelled") {
      return { orderId: idOf(attempt.order), status: "Cancelled", attemptId: Number(attempt.id) };
    }
    // A later browser decline must not overwrite success evidence or processing state.
    const successEvidence = code === "0" || Boolean(state.saleReferenceId);
    const nextState: MellatState = {
      ...state, callbackAt: state.callbackAt || nowIso(),
      callbackCode: successEvidence ? "0" : code,
      ...(saleReferenceId && code === "0" ? { saleReferenceId } : {}),
    };
    await save(strapi, attempt, nextState, {
      nextAction: "mellat_reconcile", nextActionAt: new Date(),
      // Even a locally expired attempt must process a late successful callback.
      ...(successEvidence ? { Status: "Unknown", resolvedAt: null } : {}),
    }, trx);
    return { orderId: idOf(attempt.order), status: "Unknown", attemptId: Number(attempt.id) };
  });
  if (!result) throw new Error("MELLAT_CALLBACK_UNCORRELATED");
  if (result.status === "Unknown") await enqueueSafely(strapi, result.attemptId);
  return result;
}

type Lease = { attempt: any; state: MellatState; version: number; orderId: number };

async function claim(strapi: Strapi, id: number): Promise<Lease | null> {
  return inAttemptTransaction(strapi, id, async (attempt, trx) => {
    const state = readMellatState(attempt);
    if (!state || attempt.Status === "Succeeded" || state.phase === "completed" ||
        (["Failed", "Cancelled"].includes(attempt.Status) && !attempt.nextAction)) return null;
    if (attempt.leaseUntil && new Date(attempt.leaseUntil).getTime() > Date.now()) return null;
    const version = Number(attempt.leaseVersion || 0) + 1;
    const nextState = { ...state };
    // An expired worker may already have called the bank; observe before repeating a mutation.
    if (state.pendingOperation) nextState.pendingOperation = "inquiry";
    await save(strapi, attempt, nextState, {
      leaseVersion: version, leaseUntil: new Date(Date.now() + MELLAT_LEASE_MS),
    }, trx);
    return { attempt, state: nextState, version, orderId: idOf(attempt.order) };
  });
}

async function persistLease(
  strapi: Strapi, lease: Lease, patch: Partial<MellatState>, data: any = {},
): Promise<boolean> {
  const result = await inAttemptTransaction(strapi, Number(lease.attempt.id), async (attempt, trx) => {
    if (Number(attempt.leaseVersion) !== lease.version || !attempt.leaseUntil ||
        new Date(attempt.leaseUntil).getTime() <= Date.now() || attempt.Status === "Succeeded") return false;
    const state = { ...readMellatState(attempt)!, ...patch };
    await save(strapi, attempt, state, data, trx);
    lease.attempt = { ...attempt, ...data };
    lease.state = state;
    return true;
  });
  return result === true;
}

async function defer(strapi: Strapi, lease: Lease, reason: string) {
  const retries = Number(lease.state.retryCount || 0);
  const delay = MELLAT_RETRY_DELAYS_MS[Math.min(retries, MELLAT_RETRY_DELAYS_MS.length - 1)];
  let alertedAt = lease.state.alertedAt;
  const since = Date.parse(lease.state.processingStartedAt || lease.state.callbackAt || lease.attempt.createdAt);
  if (!alertedAt && Number.isFinite(since) && Date.now() - since >= 15 * 60_000) {
    strapi.log.error(`Mellat payment remains unresolved attempt=${lease.attempt.id} order=${lease.orderId} reason=${reason}`);
    Sentry.captureMessage("Mellat payment remains unresolved", {
      level: "error", tags: { area: "payment", gateway: "mellat" },
      extra: { attemptId: lease.attempt.id, orderId: lease.orderId, reason },
    });
    alertedAt = nowIso();
  }
  const pendingOperation = ["verifying", "settling", "reversing"].includes(lease.state.phase)
    ? "inquiry" as const : lease.state.pendingOperation;
  const saved = await persistLease(strapi, lease, { retryCount: retries + 1, lastError: reason, alertedAt, pendingOperation }, {
    Status: "Unknown", failureCode: reason, nextAction: "mellat_reconcile",
    nextActionAt: new Date(Date.now() + delay), leaseUntil: null, lastReconciledAt: new Date(),
  });
  if (saved) await enqueueSafely(strapi, Number(lease.attempt.id), delay);
}

/** Pin inventory and the wallet tender before the first verification can reach the bank. */
async function protectStock(strapi: Strapi, lease: Lease): Promise<boolean> {
  const result = await inAttemptTransaction(strapi, Number(lease.attempt.id), async (attempt, trx) => {
    if (Number(attempt.leaseVersion) !== lease.version) return false;
    const state = readMellatState(attempt)!;
    if (state.stockProtected) { lease.state = state; return true; }
    const order: any = attempt.order;
    if (order.Status !== "Paying" || order.ReservationStatus !== "Reserved" ||
        !order.ReservedUntil || new Date(order.ReservedUntil).getTime() <= Date.now()) return false;
    if (Number(attempt.WalletAmount || 0) > 0 && attempt.WalletHoldStatus !== "Active") return false;
    const nextState: MellatState = { ...state, stockProtected: true, phase: "verifying", processingStartedAt: nowIso() };
    await save(strapi, attempt, nextState, { Status: "Unknown" }, trx);
    lease.state = nextState;
    return true;
  });
  return result === true;
}

async function closeUnpaid(strapi: Strapi, lease: Lease, reversed: boolean) {
  const result = await inAttemptTransaction(strapi, Number(lease.attempt.id), async (attempt, trx) => {
    if (Number(attempt.leaseVersion) !== lease.version || !attempt.leaseUntil ||
        new Date(attempt.leaseUntil).getTime() <= Date.now() || attempt.Status === "Succeeded") return null;
    const state = readMellatState(attempt)!;
    // Recheck under both locks: a success callback may have arrived after this
    // worker saw a decline. It must retain its recovery action, never be cleared.
    if (!reversed && (state.saleReferenceId || state.stockProtected)) {
      await save(strapi, attempt, state, {
        Status: "Unknown", nextAction: "mellat_reconcile", nextActionAt: new Date(), leaseUntil: null,
      }, trx);
      return { retry: true as const };
    }
    const terminalState: MellatState = {
      ...state, stockProtected: false, phase: reversed ? "reversed" : "review", pendingOperation: undefined,
      ...(reversed ? { reversedAt: nowIso() } : {}),
    };
    // Unprotect, release/cancel and close the attempt in one transaction. A
    // crash cannot leave stock available while a bank outcome remains pending.
    await save(strapi, attempt, terminalState, {}, trx);
    const cancellation = await cancelOrderAndRelease(strapi, lease.orderId, idOf(attempt.contract), undefined,
      reversed ? "mellat_reversed" : "mellat_declined", {
        transaction: trx,
        contractData: { external_source: "Mellat" },
        cancellationReasonCode: reversed ? "payment_expired" : undefined,
      });
    await save(strapi, attempt, terminalState, {
      Status: reversed || state.callbackCode === "17" ? "Cancelled" : "Failed",
      providerStatus: reversed ? "REVERSED" : "DECLINED", nextAction: null,
      nextActionAt: null, leaseUntil: null, resolvedAt: new Date(),
    }, trx);
    await strapi.db.query("api::order-log.order-log").create({
      data: { order: lease.orderId, Action: "Update",
        Description: reversed ? "Mellat reversal confirmed" : "Mellat checkout declined",
        Changes: { saleOrderId: state.saleOrderId, saleReferenceId: state.saleReferenceId, code: state.lastCode ?? state.callbackCode } },
      transacting: trx,
    } as any);
    return { retry: false as const, afterCommit: cancellation?.afterCommit };
  });
  if (result?.retry) await enqueueSafely(strapi, Number(lease.attempt.id));
  else if (result && "afterCommit" in result) await result.afterCommit?.();
}

async function finalize(strapi: Strapi, lease: Lease) {
  try {
    await finalizeGatewaySettlement(strapi, {
      orderId: lease.orderId, contractId: idOf(lease.attempt.contract),
      paymentAttemptId: Number(lease.attempt.id), gateway: "Mellat", mellatLeaseVersion: lease.version,
      contractData: { external_source: "Mellat", external_id: lease.state.saleReferenceId },
      contractTransactionData: {
        Amount: lease.state.amountIrr, TrackId: lease.state.refId,
        external_id: lease.state.saleReferenceId, external_source: "Mellat", SettlementGateway: "Mellat",
        GatewayRefId: lease.state.saleReferenceId, GatewayStatus: "SETTLED", SettledAt: new Date(),
      },
      auditDescription: "Mellat payment confirmed and settled",
      auditChanges: { saleOrderId: lease.state.saleOrderId, saleReferenceId: lease.state.saleReferenceId },
    });
  } catch (error) {
    await defer(strapi, lease, "MELLAT_LOCAL_SETTLEMENT_PENDING");
    return;
  }
  // These effects already have durable repair/idempotency guards; never re-charge for an effect failure.
  const { completeMellatSettlementEffects } = await import("../../order/controllers/helpers/payment");
  await completeMellatSettlementEffects(strapi, lease.orderId);
}

export async function processMellatAttempt(strapi: Strapi, attemptId: number): Promise<void> {
  const lease = await claim(strapi, attemptId);
  if (!lease) return;
  if (lease.state.terminalFingerprint !== mellatTerminalFingerprint()) {
    await defer(strapi, lease, "MELLAT_TERMINAL_CHANGED"); return;
  }
  if (lease.state.phase === "reversed") { await closeUnpaid(strapi, lease, true); return; }
  if (lease.state.phase === "settled") { await finalize(strapi, lease); return; }
  if (!lease.state.saleReferenceId) {
    if (lease.state.callbackCode && lease.state.callbackCode !== "0" && !lease.state.stockProtected) {
      await closeUnpaid(strapi, lease, false); return;
    }
    await defer(strapi, lease, "MELLAT_CALLBACK_REFERENCE_UNAVAILABLE"); return;
  }
  const service = strapi.service("api::payment-gateway.mellat-v3") as any;
  const params = {
    orderId: lease.state.saleOrderId, saleOrderId: lease.state.saleOrderId,
    saleReferenceId: lease.state.saleReferenceId,
  };
  let action: "verify" | "settle" | "inquiry" | "reverse" = lease.state.pendingOperation === "inquiry"
    ? "inquiry" : lease.state.phase === "verified" ? "settle" : lease.state.phase === "reversing" ? "inquiry" : "verify";
  if (!lease.state.stockProtected && !(await protectStock(strapi, lease))) action = "reverse";
  try {
    for (let step = 0; step < 3; step += 1) {
      if (action === "settle" && !lease.state.stockProtected) {
        await defer(strapi, lease, "MELLAT_SETTLEMENT_WITHOUT_STOCK_REFUSED"); return;
      }
      const phase = action === "verify" ? "verifying" : action === "settle" ? "settling" : action === "reverse" ? "reversing" : lease.state.phase;
      if (!(await persistLease(strapi, lease, { phase, pendingOperation: action }, {
        leaseUntil: new Date(Date.now() + MELLAT_LEASE_MS),
      }))) return;
      const method = { verify: "verifyTransaction", settle: "settleTransaction", inquiry: "inquiryTransaction", reverse: "reverseTransaction" }[action];
      const response = await service[method](params);
      if (!(await persistLease(strapi, lease, { responses: responseEvidence(lease.state, action, response) }))) return;
      if (response?.ambiguous || !Number.isInteger(response?.resCode)) {
        await defer(strapi, lease, "MELLAT_PROVIDER_RESPONSE_UNKNOWN"); return;
      }
      const code = Number(response.resCode);
      if (!(await persistLease(strapi, lease, { lastCode: code, pendingOperation: undefined }))) return;
      if (code === 48 || (action === "reverse" && code === 0)) {
        await closeUnpaid(strapi, lease, true); return;
      }
      if ((action === "settle" && [0, 45].includes(code)) || (action === "inquiry" && code === 45)) {
        if (!lease.state.stockProtected) {
          await defer(strapi, lease, "MELLAT_SETTLED_WITHOUT_LOCAL_RESERVATION"); return;
        }
        if (!(await persistLease(strapi, lease, { phase: "settled", settledAt: nowIso() }))) return;
        await finalize(strapi, lease); return;
      }
      if (action === "verify" && [0, 43].includes(code)) {
        if (!(await persistLease(strapi, lease, { phase: "verified", verifiedAt: nowIso() }))) return;
        action = "settle"; continue;
      }
      if (action === "inquiry" && [0, 43, 44, 46].includes(code)) {
        action = !lease.state.stockProtected ? "reverse" : lease.state.verifiedAt ? "settle" : "verify";
        continue;
      }
      await defer(strapi, lease, `MELLAT_${action.toUpperCase()}_${code}`); return;
    }
    await defer(strapi, lease, "MELLAT_RECONCILIATION_PENDING");
  } catch (error) {
    await defer(strapi, lease, "MELLAT_RECOVERY_INTERRUPTED");
  }
}

export async function reconcileMellatOrder(strapi: Strapi, orderId: number) {
  const attempt: any = await strapi.db.query(MELLAT_ATTEMPT_UID).findOne({
    where: { Gateway: "mellat", order: { id: orderId } }, orderBy: { createdAt: "desc" },
  } as any);
  if (!attempt) return;
  const queued = await inAttemptTransaction(strapi, Number(attempt.id), async (current, trx) => {
    const state = readMellatState(current);
    if (!state || current.Status === "Succeeded" ||
        (state.phase === "reversed" && state.reversedAt && current.Status === "Cancelled")) return false;
    await save(strapi, current, state, { nextAction: "mellat_reconcile", nextActionAt: new Date() }, trx);
    return true;
  });
  if (queued) await enqueueSafely(strapi, Number(attempt.id));
}

export async function sweepMellatAttempts(strapi: Strapi) {
  const attempts: any[] = await strapi.db.query(MELLAT_ATTEMPT_UID).findMany({
    where: { Gateway: "mellat", nextAction: "mellat_reconcile", nextActionAt: { $lte: new Date() } },
    orderBy: { nextActionAt: "asc" }, limit: 100,
  } as any);
  for (const attempt of attempts || []) await enqueueSafely(strapi, Number(attempt.id));
  return { processed: (attempts || []).length };
}

export default ({ strapi }: { strapi: Strapi }) => ({
  acceptCallback: (body: Record<string, unknown>) => acceptMellatCallback(strapi, body),
  processAttempt: (id: number) => processMellatAttempt(strapi, id),
  reconcileOrder: (id: number) => reconcileMellatOrder(strapi, id),
});
