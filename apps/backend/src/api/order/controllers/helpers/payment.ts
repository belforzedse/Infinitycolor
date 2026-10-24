import { acceptMellatCallback } from "../../../payment-gateway/services/mellat-coordinator";
import * as Sentry from "@sentry/node";
import type { Strapi } from "@strapi/strapi";
import { consumeOrderReservation } from "../../../../utils/stockReservations";
import { cancelOrderAndRelease } from "../../../cart/controllers/handlers/gateway-helpers";
import { orderHoldsDiscountClaim } from "../../../cart/services/lib/discount-claim";
import { consumeCheckoutCartLinesSafely } from "../../../cart/services/lib/order-cart-cleanup";
import { enqueueOrderPaid } from "../../../report/analytics/outbox";
import {
  findOrderPaymentAttempt,
  findPaymentAttemptByProviderReference,
  updatePaymentAttempt,
  claimPaymentAttemptForSettlement,
} from "../../../payment-attempt/services/payment-attempt";
import { settleZarinPalPayment, ZarinPalSettlementError } from "./zarinpalSettlement";
import {
  finalizeGatewaySettlement,
  GatewayLocalSettlementError,
} from "./gatewaySettlement";
import { snappayCallbackHandler } from "./snappayCallback";
import {
  hashSnappayCallbackNonce,
  isValidSnappayCallbackNonce,
} from "../../../payment-gateway/services/snappay-security";
import {
  gatewayExpectedAmountIrr,
  readPaymentAttemptLegs,
} from "../../../payment-attempt/services/payment-legs";
import { routeExpectedDiagnostic } from "../../../../utils/diagnostic-log";

const getFrontendBaseUrl = () =>
  (process.env.FRONTEND_BASE_URL || process.env.FRONTEND_URL || "https://infinitycolor.co").replace(
    /\/$/,
    "",
  );

// Only callback outcomes already identified as customer/card declines belong in
// Logs. Provider configuration, system, malformed, and unknown statuses stay actionable.
const MELLAT_EXPECTED_DECLINES = new Set(["11", "12", "13", "14", "15", "16", "17", "18", "19"]);
const SAMAN_EXPECTED_STATES = new Set(["CANCELEDBYUSER", "FAILED", "SESSIONISNULL"]);
export const isExpectedProviderCallbackFailure = (gateway: "mellat" | "saman", status: string): boolean =>
  (gateway === "mellat" ? MELLAT_EXPECTED_DECLINES : SAMAN_EXPECTED_STATES).has(status);

// Shared by every gateway (Saman, Mellat, ZarinPal — SnappPay's own
// `paymentResultUrl` in snappay-orchestrator.ts targets the same page
// independently). `/payment/result` re-fetches the order's real payment
// status from the backend and polls until terminal; it does not trust
// `resultHint` or any other query param as ground truth, so it's safe for
// every gateway to redirect through, including ones with weaker callback
// integrity guarantees than the trusted post-verify state that sets it.
export const buildPaymentResultRedirectUrl = (
  type: "success" | "failure" | "cancelled" | "issue",
  params?: Record<string, string | number | null | undefined>,
  expectedOutcome = false,
) => {
  const url = new URL(`${getFrontendBaseUrl()}/payment/result`);
  url.searchParams.set("resultHint", type);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      url.searchParams.set(key, String(value));
    });
  }
  // The redirect is a UI hint, not a severity classification or settlement proof.
  if (type !== "success") {
    const hasOrder = params?.orderId != null && params.orderId !== "";
    const hasTransaction = Boolean(params?.transactionId);
    // Empty/prefetch GETs and other uncorrelated junk have nothing to attach
    // to an order. Reporting them as payment.result:failure drowns real declines.
    if (hasOrder || hasTransaction) {
      try {
        const reasonCode = String(params?.code ?? type);
        const expected = expectedOutcome || type === "cancelled" || reasonCode === "return_without_result";
        if (expected && routeExpectedDiagnostic(`payment.result:${type}`, {
          area: "payment", stage: "callback", resultHint: type, reasonCode, hasTransactionId: hasTransaction,
        })) return url.toString();
        Sentry.captureMessage(`payment.result:${type}`, {
          level: type === "issue" ? "error" : "warning",
          tags: {
            area: "payment",
            stage: "callback",
            resultHint: type,
            reasonCode,
          },
          extra: {
            orderId: params?.orderId ?? null,
            // Never the provider's transaction id itself — only whether we had one.
            hasTransactionId: hasTransaction,
          },
        });
      } catch {
        // A failed report must not break the customer's redirect back to the site.
      }
    }
  }
  return url.toString();
};

async function incrementDiscountUsageCounter(
  strapi: Strapi,
  discountCode: string,
  orderId: number,
) {
  if (!discountCode) return; // No discount code to track

  try {
    // Usage-limited coupons are claimed at checkout, inside the transaction that made
    // the discounted order and its contract amount durable. Counting them again at
    // settlement would let the cap be exceeded by one per order.
    if (await orderHoldsDiscountClaim(strapi, orderId)) {
      strapi.log.debug("Discount usage already claimed at checkout; skipping settlement increment", {
        orderId,
        discountCode,
      });
      return;
    }

    // Find the discount by code
    const discount = await strapi.entityService.findMany("api::discount.discount", {
      filters: { Code: discountCode },
      limit: 1,
    });

    if (!discount || !discount[0]) {
      strapi.log.warn(
        `Discount code "${discountCode}" not found when incrementing usage for order ${orderId}`,
      );
      return;
    }

    const discountId = discount[0].id;
    const limitUsage = Number(discount[0].LimitUsage || 0);
    const currentUsedTimes = Number(discount[0].UsedTimes || 0);
    const discountAmount = Number(discount[0].Amount || 0);
    const discountType = discount[0].Type || "Unknown";

    // Atomically increment UsedTimes with race condition protection
    // Only increment if usage limit hasn't been reached (LimitUsage = 0 means unlimited)
    let updateResult: any;
    if (limitUsage > 0) {
      // Check limit: only increment if UsedTimes < LimitUsage
      // Note: Strapi converts camelCase to snake_case, so "UsedTimes" becomes "used_times"
      const result = await strapi.db.connection.raw(
        `UPDATE discounts
         SET used_times = used_times + 1
         WHERE id = ? AND used_times < ?
         RETURNING used_times`,
        [discountId, limitUsage],
      );

      const rows = result.rows || [];
      if (rows.length === 0) {
        // No rows updated means limit already reached or exceeded
        strapi.log.warn(
          `Discount code "${discountCode}" usage limit already reached (${currentUsedTimes}/${limitUsage})`,
          {
            orderId,
            discountId,
            discountCode,
            currentUsedTimes,
            limitUsage,
          },
        );
        return;
      }

      updateResult = { UsedTimes: rows[0].used_times };
    } else {
      // Unlimited usage - safe to increment directly
      // Note: Strapi converts camelCase to snake_case, so "UsedTimes" becomes "used_times"
      const result = await strapi.db.connection.raw(
        `UPDATE discounts
         SET used_times = used_times + 1
         WHERE id = ?
         RETURNING used_times`,
        [discountId],
      );

      const rows = result.rows || [];
      if (rows.length === 0) {
        strapi.log.warn(`Discount with id ${discountId} not found for atomic update`);
        return;
      }

      updateResult = { UsedTimes: rows[0].used_times };
    }

    const newUsedTimes = updateResult.UsedTimes;

    // Log to order-log for audit trail
    try {
      await strapi.entityService.create("api::order-log.order-log", {
        data: {
          order: orderId,
          Action: "Update",
          Description: `Discount code "${discountCode}" successfully applied`,
          Changes: {
            discountCode,
            discountId,
            discountType,
            discountAmount,
            usageTrackingBefore: currentUsedTimes,
            usageTrackingAfter: newUsedTimes,
          },
        },
      });
    } catch (logErr) {
      strapi.log.error("Failed to create discount usage audit log", logErr);
    }

    strapi.log.info(
      `Discount usage incremented atomically for code "${discountCode}" (order ${orderId}): ${currentUsedTimes} → ${newUsedTimes}`,
      {
        orderId,
        discountId,
        discountCode,
        discountType,
        discountAmount,
        limitUsage: limitUsage > 0 ? limitUsage : "unlimited",
      },
    );
  } catch (error) {
    strapi.log.error(
      `Failed to increment discount usage counter for code "${discountCode}" on order ${orderId}:`,
      error,
    );
    // Don't throw - this shouldn't block payment completion
  }
}

/**
 * Consumes only the cart lines this order was built from.
 *
 * Formerly cleared the whole live cart, which discarded anything the customer added
 * while they were at the gateway. Cleanup failure is deliberately not propagated: a
 * confirmed payment must stay confirmed. The work stays durably pending instead
 * (orders.CartCleanupCompletedAt NULL) and the reconcile sweep retries it.
 */
async function clearCartAfterPayment(strapi: Strapi, orderId?: number, gateway?: string) {
  if (!orderId) {
    strapi.log.warn("clearCartAfterPayment called without orderId");
    return;
  }

  // Durable `order_paid` diagnostic, only after payment is confirmed. The
  // scheduled repair sweep reconstructs it if the process exits here. The
  // revenue-bearing `purchase` comes from the storefront result page.
  void enqueueOrderPaid(strapi as any, orderId).catch(() => {});

  await consumeCheckoutCartLinesSafely(strapi, orderId, { gateway });
}

/**
 * An escaping throw means the shopper's browser lands on a 500 coming back from
 * the gateway, after their card has already been charged. That is the worst
 * outcome checkout has, so it is always reported before being rethrown.
 */
export async function verifyPaymentHandler(strapi: Strapi, ctx: any) {
  try {
    return await runVerifyPaymentHandler(strapi, ctx);
  } catch (error) {
    try {
      Sentry.captureException(error, {
        level: "fatal",
        tags: { area: "payment", stage: "callback", reasonCode: "CALLBACK_UNCAUGHT" },
        extra: { method: String((ctx?.request as any)?.method || ctx?.method || "") },
      });
    } catch {
      // Swallow: the original failure is what matters.
    }
    throw error;
  }
}

/**
 * Resolves the order behind a SnappPay return that carried only the nonce.
 *
 * `callbackNonceHash` is a plain SHA-256 of the nonce, so this is a direct
 * lookup rather than a scan. Returns null when nothing matches — an unknown or
 * replayed nonce must fall through to the uncorrelated path, never guess an
 * order.
 */
export async function completeMellatSettlementEffects(strapi: Strapi, orderId: number) {
  const order: any = await strapi.entityService.findOne("api::order.order", orderId, { fields: ["Status", "DiscountCode"] } as any);
  if (!order || !["Started", "Shipment", "Done"].includes(String(order.Status))) return;
  if (order.DiscountCode) await incrementDiscountUsageCounter(strapi, order.DiscountCode, orderId);
  await clearCartAfterPayment(strapi, orderId, "Mellat");
}

async function findSnappayOrderIdByCallbackNonce(
  strapi: Strapi,
  nonce: string,
): Promise<number | null> {
  try {
    const attempt: any = await strapi.db
      .query("api::payment-attempt.payment-attempt")
      .findOne({
        where: {
          Gateway: "snappay",
          callbackNonceHash: hashSnappayCallbackNonce(nonce),
        },
        populate: { order: true },
        orderBy: { createdAt: "desc" },
      } as any);
    const orderId = Number(attempt?.order?.id);
    return Number.isFinite(orderId) && orderId > 0 ? orderId : null;
  } catch (error: any) {
    strapi.log.error("Failed to correlate SnappPay callback nonce", {
      error: String(error?.message || error).slice(0, 300),
    });
    return null;
  }
}

async function runVerifyPaymentHandler(strapi: Strapi, ctx: any) {
  // Mellat returns: ResCode, SaleOrderId, SaleReferenceId, RefId, OrderId
  const { ResCode, SaleOrderId, SaleReferenceId, RefId, OrderId } = (ctx.request as any).body || {};

  // SnappPay callback fields may arrive via POST body or GET query
  // Normalize from both sources and accept common aliases
  const q: any = (ctx.request as any).query || {};
  const b: any = (ctx.request as any).body || {};
  const zarinpalAuthorityInput: string | undefined = (b.Authority ??
    q.Authority ??
    b.authority ??
    q.authority) as any;
  const zarinpalStatusInput: string | undefined = (b.Status ??
    q.Status ??
    b.status ??
    q.status) as any;
  const state: string | undefined = (b.state ?? q.state) as any;
  const paymentTokenInput: string | undefined = (b.paymentToken ??
    q.paymentToken ??
    b.payment_token ??
    q.payment_token) as any;
  const transactionIdInput: string | undefined = (b.transactionId ??
    q.transactionId ??
    b.transaction_id ??
    q.transaction_id) as any;
  const samanStateInput: any = b.State ?? q.State ?? b.STATE ?? q.STATE ?? b.state ?? q.state;
  const samanStatusInput: any =
    b.Status ?? q.Status ?? b.STATUS ?? q.STATUS ?? b.status ?? q.status;
  const samanRefNumInput: any =
    b.RefNum ?? q.RefNum ?? b.refNum ?? q.refnum ?? q.RefNum ?? b.RefNum;
  const samanResNumInput: any =
    b.ResNum ?? q.ResNum ?? b.resNum ?? q.resnum ?? q.ResNum ?? b.ResNum;

  try {
    const hasOwn = (value: unknown, key: string): boolean =>
      value !== null &&
      typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, key);
    const snappayAliasInput =
      String((ctx.request as any).method || ctx.method || "").toUpperCase() === "POST" &&
      hasOwn(q, "nonce") &&
      hasOwn(b, "transactionId") &&
      hasOwn(b, "state") &&
      hasOwn(b, "amount");
    if (snappayAliasInput) {
      // The registered SnappPay return URL is the shared callback endpoint. A
      // real SnappPay return is a POST with these documented lowercase fields
      // plus the per-attempt nonce appended to returnURL by the orchestrator.
      // Correlation, amount matching, and idempotency remain owned by the
      // hardened callback handler; the legacy SnappPay service is never reached.
      return snappayCallbackHandler(strapi, ctx);
    }

    const legacySnappayInput =
      Boolean(transactionIdInput || paymentTokenInput) ||
      (["OK", "FAILED"].includes(String(state || "").toUpperCase()) &&
        (b.amount !== undefined || b.OrderId !== undefined) &&
        !samanRefNumInput &&
        !samanResNumInput);
    if (legacySnappayInput) {
      return ctx.badRequest("SnappPay callback endpoint has changed", {
        data: {
          success: false,
          errorCode: "SNAPPAY_LEGACY_CALLBACK_DISABLED",
        },
      });
    }

    strapi.log.info("Payment callback received", {
      method: String((ctx.request as any).method || ""),
      hasMellatReference: Boolean(SaleReferenceId || RefId),
      hasSamanReference: Boolean(samanRefNumInput || samanResNumInput),
      hasZarinpalAuthority: Boolean(zarinpalAuthorityInput),
    });

    const present = (value: unknown) => value !== undefined && value !== null && String(value).trim() !== "";
    const hasMellatBodyField =
      present(ResCode) ||
      present(SaleReferenceId) ||
      present(RefId) ||
      present(OrderId) ||
      present(SaleOrderId);
    const hasProviderIdentifyingFields = Boolean(
      hasMellatBodyField ||
        zarinpalAuthorityInput !== undefined ||
        samanStateInput !== undefined ||
        samanStatusInput !== undefined ||
        samanRefNumInput !== undefined ||
        samanResNumInput !== undefined,
    );
    if (!hasProviderIdentifyingFields) {
      // SnappPay returns a sizeable share of shoppers to the merchant with a
      // bare GET carrying only the per-attempt nonce and none of the documented
      // POST fields (transactionId/state/amount). That is not a result we may
      // act on — the workbook requires POST — but the nonce identifies the
      // attempt exactly, and the customer is sitting on the result page right
      // now. Dropping it as "uncorrelated" sent them to /payment/result with no
      // orderId, so the page had nothing to poll and showed a dead generic
      // failure while the attempt stayed unresolved for the rest of the
      // provider's window. Correlate it, kick an immediate reconcile, and hand
      // the page the order id. The provider state still comes only from
      // GET /status — this request is never treated as a payment result.
      const snappayNonce = String(q.nonce ?? "").trim();
      if (isValidSnappayCallbackNonce(snappayNonce)) {
        const correlatedOrderId = await findSnappayOrderIdByCallbackNonce(
          strapi,
          snappayNonce,
        );
        if (correlatedOrderId) {
          strapi.log.warn("SnappPay return carried no result fields; reconciling by nonce", {
            method: String((ctx.request as any).method || ctx.method || ""),
            orderId: correlatedOrderId,
          });
          try {
            await strapi
              .service("api::payment-gateway.snappay-orchestrator")
              .reconcileOrder(correlatedOrderId, "return_without_result");
          } catch (error: any) {
            try {
              Sentry.captureException(error, { tags: { area: "payment", stage: "reconcile_return", reasonCode: "return_reconciliation_failed" } });
            } catch { /* Telemetry must not interrupt the return. */ }
            strapi.log.error("Failed to reconcile SnappPay return correlated by nonce", {
              orderId: correlatedOrderId,
              error: String(error?.message || error).slice(0, 300),
            });
          }
          return ctx.redirect(
            buildPaymentResultRedirectUrl("issue", {
              orderId: correlatedOrderId,
              code: "return_without_result",
            }),
          );
        }
      }
      strapi.log.info("Payment callback had no provider identifying fields; ignoring", {
        method: String((ctx.request as any).method || ctx.method || ""),
      });
      return ctx.redirect(
        buildPaymentResultRedirectUrl("failure", {
          code: "uncorrelated_callback",
        }),
      );
    }

    const isZarinPalFlow = !ResCode && zarinpalAuthorityInput !== undefined;

    if (isZarinPalFlow) {
      const authority =
        zarinpalAuthorityInput !== undefined && zarinpalAuthorityInput !== null
          ? String(zarinpalAuthorityInput).trim()
          : "";
      const callbackStatus =
        zarinpalStatusInput !== undefined && zarinpalStatusInput !== null
          ? String(zarinpalStatusInput).trim().toUpperCase()
          : "";

      if (!authority) {
        strapi.log.error("ZarinPal callback missing authority", {
          callbackStatus,
        });
        return ctx.redirect(
          buildPaymentResultRedirectUrl("failure", {
            error: "Missing ZarinPal authority",
          }),
        );
      }

      let contractTransaction: any | undefined;
      const findTransaction = async (filters: any) => {
        const matches = (await strapi.entityService.findMany(
          "api::contract-transaction.contract-transaction",
          {
            filters,
            populate: { contract: { populate: { order: true } } },
            sort: { createdAt: "desc" },
            limit: 1,
          },
        )) as any[];
        return matches?.[0];
      };

      try {
        contractTransaction = await findTransaction({
          external_source: "ZarinPal",
          GatewayAuthority: authority,
        });
        if (!contractTransaction) {
          contractTransaction = await findTransaction({
            external_source: "ZarinPal",
            TrackId: authority,
          });
        }
        if (!contractTransaction) {
          contractTransaction = await findTransaction({
            external_source: "ZarinPal",
            external_id: authority,
          });
        }
      } catch (error) {
        strapi.log.error("Failed to locate ZarinPal contract transaction", {
          authority,
          error: (error as Error)?.message || error,
        });
      }

      if (!contractTransaction) {
        strapi.log.error("ZarinPal callback authority not found", { authority });
        return ctx.redirect(
          buildPaymentResultRedirectUrl("failure", {
            error: "ZarinPal transaction not found",
          }),
        );
      }

      const orderRelation = contractTransaction.contract?.order;
      const orderId =
        typeof orderRelation === "object" && orderRelation
          ? Number(orderRelation.id)
          : Number(orderRelation);
      const contractId =
        typeof contractTransaction.contract === "object" && contractTransaction.contract
          ? Number(contractTransaction.contract.id)
          : Number(contractTransaction.contract);

      if (!orderId || Number.isNaN(orderId) || !contractId || Number.isNaN(contractId)) {
        strapi.log.error("ZarinPal callback has invalid local references", {
          authority,
          txId: contractTransaction.id,
          orderId,
          contractId,
        });
        return ctx.redirect(
          buildPaymentResultRedirectUrl("failure", {
            error: "Invalid ZarinPal order reference",
          }),
        );
      }

      if (contractTransaction.Status === "Success") {
        strapi.log.info("ZarinPal callback already processed", {
          authority,
          orderId,
          txId: contractTransaction.id,
        });
        return ctx.redirect(buildPaymentResultRedirectUrl("success", { orderId }));
      }

      const orderEntity = (await strapi.entityService.findOne("api::order.order", orderId, {
        fields: ["Status", "ReservationStatus", "ReservedUntil", "DiscountCode"],
        populate: { contract: true },
      } as any)) as any;

      if (!orderEntity) {
        strapi.log.error("ZarinPal order not found", { orderId, authority });
        return ctx.redirect(
          buildPaymentResultRedirectUrl("failure", {
            error: "ZarinPal order not found",
          }),
        );
      }

      // ZarinPal verifies against the amount it was asked for. That is the
      // gateway leg: the Pending contract transaction was created with exactly
      // that figure at initiation, so it is the authoritative source here.
      // Falling back to the contract total would fail verification for every
      // split payment.
      const amountToman = Math.round(
        Number(
          Number(contractTransaction.Amount || 0) > 0
            ? Number(contractTransaction.Amount) / 10
            : (orderEntity?.contract?.Amount ?? contractTransaction?.contract?.Amount ?? 0),
        ),
      );

      const markFailed = async (
        reason: string,
        redirectType: "failure" | "cancelled" = "failure",
      ) => {
        await cancelOrderAndRelease(strapi, orderId, contractId, undefined, reason, {
          orderData: { external_source: "ZarinPal", external_id: authority },
          contractData: { external_source: "ZarinPal", external_id: authority },
          contractTransactionId: Number(contractTransaction.id),
          contractTransactionData: {
            Status: "Failed",
            GatewayAuthority: authority,
            GatewayStatus: callbackStatus || reason,
            GatewayResponse: { callbackStatus, authority, reason },
          },
        });

        try {
          await strapi.entityService.create("api::order-log.order-log", {
            data: {
              order: orderId,
              Action: "Update",
              Description: `ZarinPal gateway callback failed: ${reason}`,
              Changes: { authority, callbackStatus, reason },
            },
          });
        } catch (error) {
          strapi.log.error("Failed to log ZarinPal failure", error);
        }

        try {
          const attempt: any = await findOrderPaymentAttempt(strapi, orderId);
          if (attempt?.id) {
            await updatePaymentAttempt(strapi, Number(attempt.id), {
              Status: redirectType === "cancelled" ? "Cancelled" : "Failed",
              failureCode:
                redirectType === "cancelled"
                  ? "ZARINPAL_CANCELLED"
                  : "ZARINPAL_VERIFICATION_FAILED",
              failureMessage: reason,
              providerResponse: { callbackStatus, authority, reason },
              lastReconciledAt: new Date(),
              resolvedAt: new Date(),
            });
          }
        } catch (error) {
          strapi.log.error("Failed to update ZarinPal payment attempt", error);
        }

        return ctx.redirect(
          buildPaymentResultRedirectUrl(redirectType, {
            orderId,
            error: reason,
            reason: redirectType === "cancelled" ? "user-cancelled" : undefined,
          }),
        );
      };

      if (callbackStatus !== "OK") {
        return markFailed(callbackStatus || "NOK", "cancelled");
      }

      const zarinpalService = strapi.service("api::payment-gateway.zarinpal") as any;
      const verificationResult = await zarinpalService.verifyPayment({
        authority,
        amountToman,
      });

      if (!verificationResult?.success) {
        if (verificationResult?.ambiguous) {
          const reason =
            verificationResult?.message ||
            verificationResult?.error ||
            "ZarinPal verification result is temporarily unknown";
          try {
            await strapi.entityService.update(
              "api::contract-transaction.contract-transaction",
              contractTransaction.id,
              {
                data: {
                  GatewayAuthority: authority,
                  GatewayStatus: "VERIFICATION_AMBIGUOUS",
                  GatewayResponse: verificationResult.gatewayResponse,
                } as any,
              },
            );
            const attempt: any = await findOrderPaymentAttempt(strapi, orderId);
            if (attempt?.id) {
              await updatePaymentAttempt(strapi, Number(attempt.id), {
                Status: "Unknown",
                failureCode: "ZARINPAL_VERIFICATION_AMBIGUOUS",
                failureMessage: reason,
                providerResponse: verificationResult.gatewayResponse,
                lastReconciledAt: new Date(),
              });
            }
          } catch (error) {
            strapi.log.error("Failed to persist ambiguous ZarinPal result", {
              orderId,
              authority,
              error: (error as Error)?.message || error,
            });
          }
          return ctx.redirect(
            buildPaymentResultRedirectUrl("issue", {
              orderId,
              code: "zarinpal_verification_ambiguous",
            }),
          );
        }
        return markFailed(
          verificationResult?.message ||
            verificationResult?.error ||
            `Verification failed with code ${verificationResult?.code ?? "unknown"}`,
        );
      }

      let settlement: Awaited<ReturnType<typeof settleZarinPalPayment>>;
      try {
        settlement = await settleZarinPalPayment(strapi, {
          orderId,
          contractId,
          contractTransactionId: Number(contractTransaction.id),
          authority,
          verification: verificationResult,
        });
      } catch (error) {
        const settlementCode =
          error instanceof ZarinPalSettlementError ? error.code : "ZARINPAL_FINALIZE_FAILED";
        try {
          await strapi.entityService.update(
            "api::contract-transaction.contract-transaction",
            contractTransaction.id,
            {
              data: {
                GatewayStatus: `VERIFIED_LOCAL_FAILURE:${settlementCode}`,
                GatewayResponse: verificationResult.gatewayResponse,
              } as any,
            },
          );
        } catch {}
        try {
          const attempt: any = await findOrderPaymentAttempt(strapi, orderId);
          if (attempt?.id) {
            await updatePaymentAttempt(strapi, Number(attempt.id), {
              Status: "Unknown",
              failureCode: settlementCode,
              failureMessage: (error as Error)?.message || settlementCode,
              providerResponse: verificationResult.gatewayResponse,
              lastReconciledAt: new Date(),
            });
          }
        } catch {}
        strapi.log.error("Failed to atomically finalize ZarinPal payment", {
          orderId,
          authority,
          settlementCode,
          error: (error as Error)?.message || error,
        });
        return ctx.redirect(
          buildPaymentResultRedirectUrl("issue", {
            orderId,
            code: settlementCode.toLowerCase(),
          }),
        );
      }

      const finalReference = settlement.finalReference;

      if (orderEntity?.DiscountCode) {
        await incrementDiscountUsageCounter(strapi, orderEntity.DiscountCode, orderId);
      }

      try {
        await strapi.entityService.create("api::order-log.order-log", {
          data: {
            order: orderId,
            Action: "Update",
            Description: verificationResult.alreadyVerified
              ? "ZarinPal gateway verify succeeded (already verified)"
              : "ZarinPal gateway verify succeeded",
            Changes: {
              authority,
              refId: verificationResult.refId,
              code: verificationResult.code,
            },
          },
        });
      } catch (error) {
        strapi.log.error("Failed to log ZarinPal success", error);
      }

      await clearCartAfterPayment(strapi, orderId, "ZarinPal");

      return ctx.redirect(
        buildPaymentResultRedirectUrl("success", {
          orderId,
          transactionId: finalReference,
        }),
      );
    }

    const isSamanFlow =
      !paymentTokenInput &&
      !transactionIdInput &&
      !ResCode &&
      (samanStateInput !== undefined ||
        samanStatusInput !== undefined ||
        samanRefNumInput !== undefined ||
        samanResNumInput !== undefined);

    if (isSamanFlow) {
      const samanService = strapi.service("api::payment-gateway.saman-kish") as any;
      const reverseSamanOrThrow = async () => {
        const reversal = await samanService.reverseTransaction({ refNum });
        if (!reversal?.success) {
          throw new Error(
            reversal?.resultDescription ||
              reversal?.error ||
              `Saman reversal failed with code ${reversal?.resultCode ?? "unknown"}`,
          );
        }
        return reversal;
      };
      const refNum =
        samanRefNumInput !== undefined && samanRefNumInput !== null
          ? String(samanRefNumInput).trim()
          : "";
      const resNumRaw =
        samanResNumInput !== undefined && samanResNumInput !== null
          ? String(samanResNumInput).trim()
          : "";
      const normalizedState =
        samanStateInput !== undefined && samanStateInput !== null
          ? String(samanStateInput).trim().toUpperCase()
          : "";
      const statusNumeric =
        samanStatusInput !== undefined &&
        samanStatusInput !== null &&
        String(samanStatusInput).trim() !== ""
          ? Number(String(samanStatusInput).replace(/\s+/g, ""))
          : NaN;

      if (!resNumRaw) {
        strapi.log.error("Saman callback missing ResNum; cannot correlate to an order", {
          refNum,
        });
        return ctx.badRequest("Invalid order reference", {
          data: { success: false, error: "Invalid order reference (Saman)" },
        });
      }

      // Idempotency check FIRST, keyed on the exact resNum recorded at
      // initiation (contract_transactions.external_id keeps that value even
      // after a successful settlement overwrites orders.external_id with the
      // RefNum below) — a replayed/duplicate callback for an already-settled
      // transaction must short-circuit here, before the correlation anchor
      // lookup, or it would be rejected by its own prior success.
      let contractTransaction: any = undefined;
      try {
        const txMatches = (await strapi.entityService.findMany(
          "api::contract-transaction.contract-transaction",
          {
            filters: {
              external_source: "SamanKish",
              external_id: resNumRaw,
            },
            populate: { contract: { populate: { order: true } } },
            sort: { createdAt: "desc" },
            limit: 1,
          },
        )) as any[];
        if (txMatches?.length) {
          contractTransaction = txMatches[0];

          if (contractTransaction.Status === "Success") {
            const existingOrderId =
              contractTransaction.contract?.order?.id || contractTransaction.contract?.order;
            if (existingOrderId) {
              strapi.log.info(
                `Saman callback already processed (idempotency check): resNum=${resNumRaw}, orderId=${existingOrderId}`,
                {
                  resNum: resNumRaw,
                  orderId: existingOrderId,
                  existingTxId: contractTransaction.id,
                },
              );
              return ctx.redirect(buildPaymentResultRedirectUrl("success", { orderId: existingOrderId }));
            }
          }
        }
      } catch (err) {
        strapi.log.error("Failed to locate Saman contract transaction by resNum", err);
      }

      // Correlation anchor: the exact resNum minted at initiation is
      // persisted on the order itself (requestSamanPayment in
      // gateway-helpers.ts), before any callback can exist. Saman's own
      // VerifyTransaction response has no ResNum field to cross-check
      // (confirmed against the official SEP doc), so this local anchor is
      // the only defense against a caller-supplied ResNum selecting an
      // arbitrary order. A resNum that doesn't match any order's current
      // external_id is forged, stale (superseded by a retry), or unknown —
      // reject without mutating anything.
      const anchorOrders = (await strapi.entityService.findMany("api::order.order", {
        filters: { external_id: resNumRaw, external_source: "SamanKish" },
        limit: 1,
      })) as any[];

      if (!anchorOrders?.length) {
        strapi.log.error("Saman callback ResNum does not match any known order", {
          resNum: resNumRaw,
          refNum,
        });
        return ctx.badRequest("Invalid order reference", {
          data: { success: false, error: "Invalid order reference (Saman)" },
        });
      }

      const orderId = Number(anchorOrders[0].id);

      // Defense in depth: only trust a found contract-transaction as an
      // update target once it's confirmed to belong to the anchor-resolved
      // order, never as a source of correlation itself.
      if (
        contractTransaction &&
        Number(contractTransaction.contract?.order?.id ?? contractTransaction.contract?.order) !==
          orderId
      ) {
        strapi.log.error(
          "Saman contract-transaction/order anchor mismatch; ignoring stale transaction",
          { resNum: resNumRaw, orderId, contractTransactionId: contractTransaction.id },
        );
        contractTransaction = undefined;
      }

      if (!contractTransaction && refNum) {
        try {
          const txMatches = (await strapi.entityService.findMany(
            "api::contract-transaction.contract-transaction",
            {
              filters: {
                external_source: "SamanKish",
                TrackId: refNum,
              },
              populate: { contract: { populate: { order: true } } },
              sort: { createdAt: "desc" },
              limit: 1,
            },
          )) as any[];
          if (
            txMatches?.length &&
            Number(txMatches[0].contract?.order?.id ?? txMatches[0].contract?.order) === orderId
          ) {
            contractTransaction = txMatches[0];
          }
        } catch (err) {
          strapi.log.error("Failed to locate Saman contract transaction by refNum", err);
        }
      }

      const orderEntity = (await strapi.entityService.findOne("api::order.order", orderId, {
        populate: {
          contract: true,
          order_items: {
            populate: {
              product_variation: { populate: { product_stock: true } },
            },
          },
        },
      })) as any;

      if (!orderEntity) {
        strapi.log.error("Saman order not found", { orderId });
        return ctx.badRequest("Order not found", {
          data: { success: false, error: "Order not found (Saman)" },
        });
      }

      if (String(orderEntity?.ReservationStatus) === "Consumed") {
        // Already fully settled by a prior callback — idempotent no-op.
        strapi.log.info("Saman callback for already-consumed order; idempotent no-op", {
          orderId,
          resNum: resNumRaw,
        });
        return ctx.redirect(buildPaymentResultRedirectUrl("success", { orderId }));
      }

      const attempt: any = await findOrderPaymentAttempt(strapi, orderId);

      const contractId =
        contractTransaction?.contract?.id ||
        (typeof orderEntity.contract === "object" && orderEntity.contract
          ? orderEntity.contract.id
          : orderEntity.contract);

      const contractAmountToman = Math.round((orderEntity.contract?.Amount ?? 0) as number);
      const contractAmountIrr = contractAmountToman * 10;

      const markOrderCancelled = async (reason: string) => {
        // Guard against destructive mutation of an order that already
        // settled successfully (e.g. this is a stale/duplicate failure
        // callback arriving after a legitimate success elsewhere). Re-read
        // fresh rather than trusting the orderEntity snapshot taken above,
        // since that snapshot may predate a concurrent settlement.
        try {
          const current: any = await strapi.entityService.findOne("api::order.order", orderId!, {
            fields: ["Status"],
          } as any);
          if (current && ["Started", "Shipment", "Done"].includes(String(current.Status))) {
            strapi.log.info("Saman failure callback ignored: order already settled", {
              orderId,
              reason,
              currentStatus: current.Status,
            });
            return;
          }
        } catch (err) {
          strapi.log.error("Failed to check order status before cancelling (Saman)", err);
          throw err;
        }
        if (!contractId) {
          throw new Error(`Saman order ${orderId} has no contract during cancellation`);
        }
        await cancelOrderAndRelease(strapi, Number(orderId), Number(contractId), undefined, reason, {
          reservationStatus: reason.startsWith("reservation_") ? "Expired" : "Released",
          contractData: { external_source: "SamanKish" },
          contractTransactionId: contractTransaction?.id
            ? Number(contractTransaction.id)
            : undefined,
          contractTransactionData: { Status: "Failed" },
          cancellationReasonCode: reason.startsWith("reservation_")
            ? "payment_expired"
            : undefined,
        });
        try {
          await strapi.entityService.create("api::order-log.order-log", {
            data: {
              order: orderId,
              Action: "Update",
              Description: `Saman gateway failure: ${reason}`,
              Changes: {
                refNum,
                resNum: resNumRaw,
                state: normalizedState,
                status: samanStatusInput,
              },
            },
          });
        } catch (err) {
          strapi.log.error("Failed to log Saman cancellation", err);
        }
      };

      const stateSuccessful =
        normalizedState === "OK" ||
        normalizedState === "SUCCESS" ||
        (!Number.isNaN(statusNumeric) && statusNumeric === 2);

      if (!stateSuccessful) {
        // Claim the attempt to Failed before cancelling — idempotent against
        // duplicate failure callbacks, and against racing a concurrent
        // success (if the attempt is already Succeeded, this claim loses and
        // markOrderCancelled must not run). Scoped to this branch only: the
        // post-verify callers below (reservation_expired,
        // reservation_consume_failed) reach markOrderCancelled after the
        // attempt has already been claimed Succeeded and downgraded to
        // Unknown, where a fresh Pending/Redirected-gated claim would always
        // lose and wrongly suppress a cancellation they still need.
        const claimedFailed = attempt?.id
          ? await claimPaymentAttemptForSettlement(strapi, Number(attempt.id), "Failed")
          : true;
        if (attempt?.id && !claimedFailed) {
          strapi.log.info(
            "Saman failure callback: attempt already finalized elsewhere; no mutation",
            { orderId, attemptId: attempt.id },
          );
        } else {
          await markOrderCancelled(normalizedState || `Status ${samanStatusInput || "Unknown"}`);
        }
        return ctx.redirect(
          buildPaymentResultRedirectUrl("failure", {
            orderId,
            error: normalizedState || String(samanStatusInput || "FAILED"),
          }, isExpectedProviderCallbackFailure("saman", normalizedState)),
        );
      }

      const verifyResult = await samanService.verifyTransaction({ refNum });

      if (!verifyResult?.success || verifyResult?.resultCode !== 0) {
        await markOrderCancelled(verifyResult?.resultDescription || "Verification failed");
        try {
          await samanService.reverseTransaction({ refNum });
        } catch (reverseErr) {
          strapi.log.error("Saman reverse attempt failed", reverseErr);
        }
        return ctx.redirect(
          buildPaymentResultRedirectUrl("failure", {
            orderId,
            error: verifyResult?.resultDescription || "Verification failed",
          }),
        );
      }

      const detail = verifyResult.transactionDetail || verifyResult.TransactionDetail || {};
      const affectiveAmountRaw = detail?.AffectiveAmount ?? detail?.OrginalAmount;
      const affectiveAmountIrr = Number(affectiveAmountRaw);
      // The bank was asked for the gateway leg, which is the whole total unless
      // the customer paid part of it from their wallet. Comparing against the
      // total would reverse every split payment as an amount mismatch.
      const expectedAmountIrr = gatewayExpectedAmountIrr(attempt, contractAmountIrr);

      // Amount check: this, together with the ResNum anchor above and a
      // genuine provider verify success, is what actually closes Finding A
      // — a caller who knows their own order's ResNum but supplies a
      // different RefNum cannot pass all three simultaneously. Only enforce
      // when the provider gave us a positive parseable amount; a malformed
      // or absent field must not cause a false-positive reversal of a real
      // payment.
      if (Number.isFinite(affectiveAmountIrr) && affectiveAmountIrr > 0) {
        if (affectiveAmountIrr !== expectedAmountIrr) {
          strapi.log.error("Saman settled amount does not match expected amount; reversing", {
            orderId,
            resNum: resNumRaw,
            refNum,
            affectiveAmountIrr,
            expectedAmountIrr,
          });
          try {
            await reverseSamanOrThrow();
          } catch (reverseErr) {
            strapi.log.error("Saman reverse attempt failed (amount mismatch)", reverseErr);
            return ctx.redirect(
              buildPaymentResultRedirectUrl("issue", {
                orderId,
                code: "amount_mismatch_reversal_unknown",
              }),
            );
          }
          try {
            await strapi.entityService.create("api::order-log.order-log", {
              data: {
                order: orderId,
                Action: "Update",
                Description:
                  "Saman gateway amount mismatch; payment reversed, order left untouched for manual review",
                Changes: { resNum: resNumRaw, refNum, affectiveAmountIrr, expectedAmountIrr },
              },
            });
          } catch {}
          return ctx.redirect(
            buildPaymentResultRedirectUrl("issue", { orderId, code: "amount_mismatch" }),
          );
        }
      } else {
        strapi.log.error(
          "Saman verify response did not include a parseable settled amount; proceeding without amount check",
          { orderId, resNum: resNumRaw, refNum, detail },
        );
      }

      // If order is already expired/cancelled (reservation released), reverse and inform user.
      if (
        String(orderEntity?.Status) === "Cancelled" ||
        (orderEntity?.ReservationStatus && orderEntity.ReservationStatus !== "Reserved")
      ) {
        try {
          await reverseSamanOrThrow();
        } catch (reverseErr) {
          strapi.log.error("Saman reverse attempt failed (invalid reservation)", reverseErr);
          return ctx.redirect(
            buildPaymentResultRedirectUrl("issue", {
              orderId,
              code: "reservation_invalid_reversal_unknown",
            }),
          );
        }
        await markOrderCancelled("reservation_invalid");
        return ctx.redirect(
          buildPaymentResultRedirectUrl("issue", {
            orderId,
            code: "reservation_invalid_reversed",
          }),
        );
      }

      if (!contractId) {
        throw new Error(`Saman order ${orderId} has no contract during settlement`);
      }

      try {
        const localSettlement = await finalizeGatewaySettlement(strapi, {
          orderId,
          contractId: Number(contractId),
          paymentAttemptId: attempt?.id ? Number(attempt.id) : undefined,
          contractTransactionId: contractTransaction?.id
            ? Number(contractTransaction.id)
            : undefined,
          gateway: "SamanKish",
          orderData: { external_source: "SamanKish" },
          contractData: {
            external_source: "SamanKish",
            external_id: refNum,
          },
          contractTransactionData: {
            Amount: affectiveAmountIrr || expectedAmountIrr,
            TrackId: refNum,
            external_id: resNumRaw || contractTransaction?.external_id || refNum,
            external_source: "SamanKish",
          },
          auditDescription: "Saman gateway verify succeeded",
          auditChanges: {
            refNum,
            resNum: resNumRaw,
            resultCode: verifyResult.resultCode,
            detail,
          },
        });

        if (localSettlement.outcome === "already_settled") {
          strapi.log.info("Saman settlement already committed; idempotent callback", {
            orderId,
            attemptId: attempt?.id,
          });
          return ctx.redirect(buildPaymentResultRedirectUrl("success", { orderId }));
        }
      } catch (error) {
        const failureCode =
          error instanceof GatewayLocalSettlementError
            ? error.code
            : "SAMAN_LOCAL_SETTLEMENT_FAILED";
        strapi.log.error("Saman local settlement rolled back after provider verification", {
          orderId,
          failureCode,
          error: (error as Error)?.message || error,
        });
        if (attempt?.id) {
          try {
            await updatePaymentAttempt(strapi, Number(attempt.id), {
              Status: "Unknown",
              failureCode,
              failureMessage: (error as Error)?.message || failureCode,
              lastReconciledAt: new Date(),
            });
          } catch (err) {
            strapi.log.error("Failed to persist Saman local-settlement recovery state", err);
          }
        }

        try {
          await reverseSamanOrThrow();
        } catch (reverseErr) {
          strapi.log.error("Saman reversal is unknown after local settlement rollback", {
            orderId,
            failureCode,
            error: (reverseErr as Error)?.message || reverseErr,
          });
          return ctx.redirect(
            buildPaymentResultRedirectUrl("issue", {
              orderId,
              code: "saman_reversal_unknown",
            }),
          );
        }
        await markOrderCancelled(`local_settlement_rolled_back_${failureCode.toLowerCase()}`);
        return ctx.redirect(
          buildPaymentResultRedirectUrl("issue", {
            orderId,
            code: failureCode.toLowerCase(),
          }),
        );
      }

      // Increment discount usage counter if discount was applied
      if (orderEntity?.DiscountCode) {
        await incrementDiscountUsageCounter(strapi, orderEntity.DiscountCode, orderId);
      }

      // Barcode generation is now a manual super-admin action.

      await clearCartAfterPayment(strapi, orderId, "SamanKish");

      return ctx.redirect(
        buildPaymentResultRedirectUrl("success", {
          orderId,
          transactionId: refNum || "",
        }),
      );
    }

    // Persist correlated evidence first; the durable Mellat worker owns all bank calls.
    try {
      const result = await acceptMellatCallback(strapi, (ctx.request as any).body || {});
      ctx.status = 303;
      return ctx.redirect(buildPaymentResultRedirectUrl(
        result.status === "Succeeded" ? "success" : "issue",
        { orderId: result.orderId, ...(result.status === "Succeeded" ? {} : { code: "payment_pending" }) },
        result.status !== "Succeeded",
      ));
    } catch (callbackError) {
      strapi.log.warn("Rejected uncorrelated Mellat callback", { code: (callbackError as Error).message });
      return ctx.badRequest("Invalid payment reference");
    }

  } catch (error) {
    console.error("Error in payment verification callback:", error);
    const orderId = parseInt(OrderId || SaleOrderId, 10);
    try {
      if (!isNaN(orderId)) {
        await strapi.entityService.create("api::order-log.order-log", {
          data: {
            order: orderId,
            Action: "Update",
            Description: "Gateway callback internal error",
            Changes: { message: (error as any).message },
          },
        });
      }
    } catch (e) {
      strapi.log.error("Failed to persist gateway internal error log", e);
    }
    ctx.redirect(buildPaymentResultRedirectUrl("failure", { error: "Internal server error" }));
  }
}
