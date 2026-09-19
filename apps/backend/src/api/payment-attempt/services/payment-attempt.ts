import { factories } from "@strapi/strapi";
import type { Strapi } from "@strapi/strapi";
import type { PaymentAttemptStatus } from "@repo/api/commerce";
export {
  claimPaymentAttemptForInitiation,
  claimPaymentAttemptForSettlement,
  claimPaymentAttemptForSnappayInitiation,
  SNAPPAY_INITIATION_LEASE_MS,
} from "./claim-payment-attempt";
export {
  findOrderPaymentAttempt,
  findPaymentAttemptByProviderReference,
  updatePaymentAttempt,
} from "./payment-attempt-store";
import { findOrderPaymentAttempt, updatePaymentAttempt } from "./payment-attempt-store";
import { isSnappayGatewayValue } from "../../payment-gateway/services/checkout-gateway-availability";

export type { PaymentAttemptStatus } from "@repo/api/commerce";

const UID = "api::payment-attempt.payment-attempt" as const;

export async function findPaymentAttempt(
  strapi: Strapi,
  userId: number,
  attemptId: string,
  trx?: any,
) {
  return strapi.db.query(UID).findOne({
    where: { attemptId, user: { id: userId } },
    populate: { order: true, contract: true },
    ...(trx ? { transacting: trx } : {}),
  } as any);
}

export async function createPaymentAttempt(
  strapi: Strapi,
  data: Record<string, unknown>,
  trx?: any,
) {
  return strapi.db.query(UID).create({
    data,
    ...(trx ? { transacting: trx } : {}),
  } as any);
}

export const paymentAttemptResponse = (attempt: any) => {
  const status = String(attempt?.Status || "Unknown") as PaymentAttemptStatus;
  const gateway = String(attempt?.Gateway || "").trim().toLowerCase();
  const providerReference = String(attempt?.providerReference || "");
  const redirectMethod = ["mellat", "samankish"].includes(gateway) ? "POST" : "GET";
  const formFields =
    redirectMethod === "POST" && providerReference
      ? gateway === "samankish"
        ? { Token: providerReference }
        : { RefId: providerReference }
      : undefined;
  const canContinue = status === "Succeeded" || status === "Redirected";
  const inProgress = ["Created", "Pending", "Unknown"].includes(status);
  return {
    success: canContinue,
    attemptId: attempt?.attemptId,
    paymentStatus: status,
    orderId: Number(attempt?.order?.id ?? attempt?.order) || undefined,
    contractId: Number(attempt?.contract?.id ?? attempt?.contract) || undefined,
    redirectUrl: attempt?.redirectUrl || "",
    refId: providerReference,
    requestId: providerReference || attempt?.attemptId,
    redirectMethod,
    ...(formFields ? { formFields } : {}),
    // While a replay is still in progress, the attempt's `failureCode` can hold an
    // internal reconciliation label (e.g. "SNAPPAY_RECONCILIATION_PENDING") that the
    // storefront's error-code switch has never heard of, so it fell through to the
    // generic "خطا در ثبت سفارش" banner instead of the mapped "still checking" copy.
    // PAYMENT_IN_PROGRESS is the stable public contract for every in-progress status.
    errorCode: inProgress ? "PAYMENT_IN_PROGRESS" : attempt?.failureCode,
    message: inProgress ? "پرداخت قبلی هنوز در حال بررسی است" : attempt?.failureMessage,
    financialSummary: attempt?.quoteSnapshot?.financialSummary,
  };
};

export async function reconcileOrderPaymentAttempt(strapi: Strapi, order: any) {
  const orderId = Number(order?.id);
  if (!orderId) return null;
  const attempt: any = await findOrderPaymentAttempt(strapi, orderId);
  if (!attempt) return null;

  const current = String(attempt.Status || "Created") as PaymentAttemptStatus;
  // SnappPay is reconciled only against the provider-backed orchestrator.
  // Never infer settlement from an order status written by the legacy flow.
  if (isSnappayGatewayValue(attempt.Gateway)) {
    return attempt;
  }
  let next = current;
  const paidOrder = ["Started", "Shipment", "Done"].includes(String(order.Status));
  if (paidOrder) {
    next = "Succeeded";
  } else if (String(order.Status) === "Cancelled") {
    next = current === "Cancelled" ? "Cancelled" : "Failed";
  } else if (
    order.ReservationStatus === "Expired" ||
    (order.ReservationStatus === "Reserved" &&
      order.ReservedUntil &&
      new Date(order.ReservedUntil).getTime() < Date.now())
  ) {
    next = "Expired";
  } else if (
    ["Redirected", "Pending"].includes(current) &&
    attempt.redirectedAt &&
    Date.now() - new Date(attempt.redirectedAt).getTime() > 30 * 60 * 1000
  ) {
    next = "Unknown";
  }

  const terminal = ["Succeeded", "Failed", "Cancelled", "Expired"].includes(next);
  if (next !== current || !attempt.lastReconciledAt) {
    await updatePaymentAttempt(strapi, Number(attempt.id), {
      Status: next,
      lastReconciledAt: new Date(),
      ...(terminal && !attempt.resolvedAt ? { resolvedAt: new Date() } : {}),
      ...(next === "Failed" && !attempt.failureCode
        ? { failureCode: "ORDER_CANCELLED", failureMessage: "Payment did not complete" }
        : {}),
    });
    attempt.Status = next;
    attempt.lastReconciledAt = new Date();
  }

  return attempt;
}

export default factories.createCoreService(UID);
