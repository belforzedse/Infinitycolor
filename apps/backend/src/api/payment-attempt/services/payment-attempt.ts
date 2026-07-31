import { factories } from "@strapi/strapi";
import type { Strapi } from "@strapi/strapi";
import type { PaymentAttemptStatus } from "@repo/api/commerce";
export { claimPaymentAttemptForInitiation } from "./claim-payment-attempt";
export {
  findOrderPaymentAttempt,
  updatePaymentAttempt,
} from "./payment-attempt-store";
import {
  findOrderPaymentAttempt,
  updatePaymentAttempt,
} from "./payment-attempt-store";
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
  const canContinue = status === "Succeeded" || status === "Redirected";
  const inProgress = ["Created", "Pending", "Unknown"].includes(status);
  return {
    success: canContinue,
    attemptId: attempt?.attemptId,
    paymentStatus: status,
    orderId: Number(attempt?.order?.id ?? attempt?.order) || undefined,
    contractId: Number(attempt?.contract?.id ?? attempt?.contract) || undefined,
    redirectUrl: attempt?.redirectUrl || "",
    refId: attempt?.providerReference || "",
    requestId: attempt?.providerReference || attempt?.attemptId,
    errorCode:
      attempt?.failureCode || (inProgress ? "PAYMENT_IN_PROGRESS" : undefined),
    message:
      attempt?.failureMessage ||
      (inProgress ? "پرداخت قبلی هنوز در حال بررسی است" : undefined),
    financialSummary: attempt?.quoteSnapshot?.financialSummary,
  };
};

export async function reconcileOrderPaymentAttempt(
  strapi: Strapi,
  order: any,
) {
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
