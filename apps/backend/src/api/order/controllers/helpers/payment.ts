import type { Strapi } from "@strapi/strapi";
import {
  consumeOrderReservation,
  releaseOrderReservation,
} from "../../../../utils/stockReservations";
import { decrementStockAtomic } from "../../../cart/services/lib/stock";
import { enqueuePurchaseForOrder } from "../../../report/analytics/outbox";
import {
  findOrderPaymentAttempt,
  findPaymentAttemptByProviderReference,
  updatePaymentAttempt,
  claimPaymentAttemptForSettlement,
} from "../../../payment-attempt/services/payment-attempt";
import { settleZarinPalPayment, ZarinPalSettlementError } from "./zarinpalSettlement";
const getFrontendBaseUrl = () =>
  (process.env.FRONTEND_BASE_URL || process.env.FRONTEND_URL || "https://infinitycolor.co").replace(
    /\/$/,
    "",
  );

// Shared by every gateway (Saman, Mellat, ZarinPal — SnappPay's own
// `paymentResultUrl` in snappay-orchestrator.ts targets the same page
// independently). `/payment/result` re-fetches the order's real payment
// status from the backend and polls until terminal; it does not trust
// `resultHint` or any other query param as ground truth, so it's safe for
// every gateway to redirect through, including ones with weaker callback
// integrity guarantees than the trusted post-verify state that sets it.
const buildPaymentResultRedirectUrl = (
  type: "success" | "failure" | "cancelled" | "issue",
  params?: Record<string, string | number | null | undefined>,
) => {
  const url = new URL(`${getFrontendBaseUrl()}/payment/result`);
  url.searchParams.set("resultHint", type);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === "") return;
      url.searchParams.set(key, String(value));
    });
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

async function clearCartAfterPayment(strapi: Strapi, orderId?: number) {
  if (!orderId) {
    strapi.log.warn("clearCartAfterPayment called without orderId");
    return;
  }

  // Insert the durable analytics event only after payment is confirmed. The
  // scheduled repair sweep reconstructs this event if the process exits here.
  void enqueuePurchaseForOrder(strapi as any, orderId).catch(() => {});

  try {
    const order = await strapi.entityService.findOne("api::order.order", orderId, {
      populate: { user: true },
    });

    if (!order) {
      strapi.log.error("clearCartAfterPayment: Order not found", { orderId });
      return;
    }

    const userRelation: any = order?.user;
    const userId =
      typeof userRelation === "object" && userRelation
        ? userRelation.id
        : typeof userRelation === "number"
        ? userRelation
        : undefined;

    if (!userId) {
      strapi.log.error("clearCartAfterPayment: Could not extract userId from order", {
        orderId,
        userRelationType: typeof userRelation,
        userRelation: userRelation,
      });
      return;
    }

    strapi.log.info("clearCartAfterPayment: Attempting to clear cart", { orderId, userId });

    const cartService: any = strapi.service("api::cart.cart");
    if (cartService?.clearCart) {
      await cartService.clearCart(userId);
      strapi.log.info("clearCartAfterPayment: Cart cleared successfully", { orderId, userId });
    } else {
      strapi.log.error("clearCartAfterPayment: Cart service or clearCart method not available");
    }
  } catch (error: any) {
    strapi.log.error("Failed to clear cart after payment", {
      orderId,
      error: error?.message || error,
      stack: error?.stack,
    });
  }
}

/**
 * Handles post-payment stock decrement with reservation awareness.
 * For reserved orders, consumes the reservation atomically.
 * For legacy orders, decrements stock directly.
 * @param strapi - Strapi instance
 * @param orderId - Order ID
 * @param gateway - Gateway name for logging context (e.g., "Saman", "SnappPay", "Mellat")
 * @returns Promise with success status, errors array, and optional expired flag
 */
async function handlePostPaymentStock(
  strapi: Strapi,
  orderId: number,
  gateway: string,
  options?: { requireReservation?: boolean },
): Promise<{ success: boolean; errors?: any[]; expired?: boolean; skipped?: boolean }> {
  try {
    // Load order with ReservationStatus field only (lightweight query)
    const orderMeta: any = await strapi.entityService.findOne("api::order.order", orderId, {
      fields: ["ReservationStatus"],
    } as any);

    if (orderMeta?.ReservationStatus === "Reserved") {
      // Reserved orders: consume reservation (Count-- and ReservedCount--) atomically
      const consumeRes = await strapi.db.transaction(async ({ trx }) =>
        consumeOrderReservation(strapi as any, Number(orderId), trx),
      );

      if (consumeRes?.expired) {
        strapi.log.error(`Reservation expired after ${gateway} settlement`, {
          orderId,
        });
        return { success: false, expired: true, errors: [{ error: "Reservation expired" }] };
      }

      if (consumeRes?.skipped) {
        // The guarded UPDATE didn't match: the reservation was already
        // released/expired/consumed by something else (an expiry-job tick,
        // a duplicate callback) between our read above and the atomic
        // consume attempt. Nothing was actually decremented — this must
        // NOT be treated as a successful consumption.
        strapi.log.error(
          `Reservation already resolved elsewhere before ${gateway} could consume it`,
          { orderId },
        );
        return {
          success: false,
          skipped: true,
          errors: [{ error: "Reservation already resolved" }],
        };
      }

      if (consumeRes?.success === false) {
        strapi.log.error(`Failed to consume reservation after ${gateway} settlement`, {
          orderId,
          error: consumeRes?.error,
        });
        return {
          success: false,
          errors: [{ error: consumeRes?.error || "Failed to consume reservation" }],
        };
      }

      return { success: true };
    } else if (options?.requireReservation) {
      // Saman/Mellat orders always go through finalizeCartToOrder's
      // reservation flow, so a non-"Reserved" status here can only mean the
      // reservation was already released/expired/consumed out from under
      // this settlement — never "this order never had a reservation"
      // (ReservationStatus schema-defaults to "Released", the same value as
      // an actively-released hold, so the two cases are indistinguishable
      // by value alone). Falling into the legacy direct-decrement branch
      // below would double-decrement stock already released back into the
      // pool. Treat as a hard stop instead.
      strapi.log.error(
        `${gateway} settlement reached stock handling with a non-Reserved reservation status`,
        { orderId, reservationStatus: orderMeta?.ReservationStatus },
      );
      return {
        success: false,
        skipped: true,
        errors: [{ error: "Reservation not active" }],
      };
    } else {
      // Legacy path: decrement stock atomically
      // Load order with populated order_items
      const orderWithItems = await strapi.entityService.findOne("api::order.order", orderId, {
        populate: {
          order_items: {
            populate: {
              product_variation: { populate: { product_stock: true } },
            },
          },
        },
      });

      const stockErrors: any[] = [];

      // Map order items to decrement promises with metadata
      const decrementPromises = (orderWithItems?.order_items || [])
        .map((it) => {
          const v = it?.product_variation;
          if (v?.product_stock?.id && typeof it?.Count === "number") {
            const stockId = v.product_stock.id as number;
            const quantity = Number(it.Count || 0);
            const variationId = v.id;

            return {
              promise: decrementStockAtomic(strapi, stockId, quantity),
              metadata: { stockId, quantity, variationId, orderId },
            };
          }
          return null;
        })
        .filter(
          (
            item,
          ): item is {
            promise: Promise<{ success: boolean; newCount?: number; error?: string }>;
            metadata: { stockId: number; quantity: number; variationId: any; orderId: number };
          } => item !== null,
        );

      // Execute all decrement promises in parallel
      const settledResults = await Promise.allSettled(
        decrementPromises.map((item) => item.promise),
      );

      // Process settled results to collect errors
      settledResults.forEach((result, index) => {
        const { metadata } = decrementPromises[index];
        const { stockId, quantity, variationId } = metadata;

        if (result.status === "fulfilled") {
          if (!result.value.success) {
            stockErrors.push({
              stockId,
              quantity,
              error: result.value.error,
              variationId,
            });
            strapi.log.error(`Failed to decrement stock atomically (${gateway})`, {
              orderId,
              stockId,
              quantity,
              error: result.value.error,
            });
          }
        } else {
          // Handle rejected promise
          const errorMessage =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          stockErrors.push({
            stockId,
            quantity,
            error: errorMessage,
            variationId,
          });
          strapi.log.error(`Failed to decrement stock atomically (${gateway})`, {
            orderId,
            stockId,
            quantity,
            error: errorMessage,
          });
        }
      });

      if (stockErrors.length > 0) {
        strapi.log.error(`Some stock decrements failed for ${gateway} payment`, {
          orderId,
          errors: stockErrors,
        });
      }

      return {
        success: stockErrors.length === 0,
        errors: stockErrors.length > 0 ? stockErrors : undefined,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    strapi.log.error(`Exception during stock handling after ${gateway} payment`, {
      orderId,
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return {
      success: false,
      errors: [{ error: errorMessage }],
    };
  }
}

async function handleStockDecrementFailure(
  strapi: Strapi,
  ctx: any,
  params: {
    orderId: number;
    stockErrors: any[];
    refNum?: string | number;
    paymentMethod: string;
    externalSource: string;
    externalId?: string | number;
  },
) {
  const { orderId, stockErrors, refNum, paymentMethod, externalSource, externalId } = params;
  const errorMessage = `Stock decrement failed for ${stockErrors.length} item(s). Order completion halted.`;
  strapi.log.error(
    `Stock decrements failed for ${paymentMethod} payment - halting order completion`,
    {
      orderId,
      errors: stockErrors,
      refNum,
    },
  );

  // Create order-log entry for tracking and manual retry
  try {
    await strapi.entityService.create("api::order-log.order-log", {
      data: {
        order: orderId,
        Action: "Update",
        Description: "CRITICAL: Stock decrement failures - order completion halted",
        Changes: {
          stockErrors: JSON.parse(JSON.stringify(stockErrors)),
          refNum,
          haltedAt: new Date().toISOString(),
          requiresManualRetry: true,
        },
      },
    });
  } catch (logErr) {
    strapi.log.error("Failed to create order-log for stock errors", logErr);
  }

  // A stock-decrement failure during a payment callback is a SYSTEM event, not an admin action,
  // so it is intentionally NOT written to the admin audit log. The order-log entry above is the
  // durable record; surface it loudly in the application logs for on-call review.
  strapi.log.error("CRITICAL: Stock decrement failure halted order completion", {
    orderId,
    refNum,
    stockErrors,
    paymentMethod,
    errorMessage,
    requiresManualRetry: true,
  });

  // Keep order in "Paying" status (payment succeeded but stock failed)
  // Don't transition to "Started" to prevent fulfillment of unavailable items
  try {
    await strapi.entityService.update("api::order.order", orderId, {
      data: {
        external_source: externalSource,
        external_id: (externalId ?? refNum) != null ? String(externalId ?? refNum) : undefined,
        // Status remains "Paying" - will require manual intervention
      },
    });
  } catch (err) {
    strapi.log.error("Failed to update order with gateway info after stock failure", err);
  }

  // Redirect to issue page with appropriate error code
  return ctx.redirect(
    buildPaymentResultRedirectUrl("issue", {
      orderId,
      code: "stock_decrement_failed",
    }),
  );
}

/**
 * Records the settled Mellat transaction on the order's contract.
 *
 * Two things depend on this row existing:
 *  - Product reports define a paid sale as `contract_transaction.Status='Success'`
 *    (see `paidOrdersCte` in api/report/services/product-analytics.ts). Without a
 *    row, Mellat sales are excluded from every report and Mellat is absent from
 *    the gateway breakdown entirely.
 *  - The callback idempotency check in `verifyPaymentHandler` looks for
 *    `{ external_source: "Mellat", external_id: SaleReferenceId, Status: "Success" }`.
 *    With no writer it could never match, so a replayed callback decremented stock
 *    and consumed the discount a second time.
 *
 * Mirrors the SamanKish shape: find-or-create, then mark Success.
 */
async function recordMellatSettlement(
  strapi: Strapi,
  params: {
    orderId: number;
    contract: any;
    saleReferenceId?: string | number;
    refId?: string | number;
  },
): Promise<void> {
  const { orderId, contract, saleReferenceId, refId } = params;
  const contractId = typeof contract === "object" && contract ? contract.id : contract;
  if (!contractId) {
    strapi.log.error("Cannot record Mellat settlement: order has no contract", {
      orderId,
    });
    return;
  }

  const externalId = String(saleReferenceId ?? refId ?? "");
  const trackId = String(refId ?? saleReferenceId ?? "");
  const contractAmountIrr = Math.round(Number(contract?.Amount ?? 0) as number) * 10;

  try {
    const existing = (await strapi.entityService.findMany(
      "api::contract-transaction.contract-transaction",
      {
        filters: {
          external_source: "Mellat",
          external_id: externalId,
        },
        limit: 1,
      },
    )) as any[];

    if (existing && existing.length > 0) {
      await strapi.entityService.update(
        "api::contract-transaction.contract-transaction",
        existing[0].id,
        {
          data: {
            Status: "Success",
            TrackId: trackId,
            Amount: contractAmountIrr || existing[0].Amount,
          },
        },
      );
      return;
    }

    await strapi.entityService.create("api::contract-transaction.contract-transaction", {
      data: {
        Type: "Gateway",
        Amount: contractAmountIrr,
        DiscountAmount: 0,
        Step: 1,
        Status: "Success",
        TrackId: trackId,
        external_id: externalId,
        external_source: "Mellat",
        contract: contractId,
        Date: new Date(),
      },
    });
  } catch (err) {
    strapi.log.error("Failed to record Mellat contract transaction", {
      orderId,
      externalId,
      error: String((err as any)?.message || err).slice(0, 300),
    });
  }
}

export async function verifyPaymentHandler(strapi: Strapi, ctx: any) {
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

      const amountToman = Math.round(
        Number(
          orderEntity?.contract?.Amount ??
            contractTransaction?.contract?.Amount ??
            Number(contractTransaction.Amount || 0) / 10,
        ),
      );

      const markFailed = async (
        reason: string,
        redirectType: "failure" | "cancelled" = "failure",
      ) => {
        try {
          await strapi.entityService.update(
            "api::contract-transaction.contract-transaction",
            contractTransaction.id,
            {
              data: {
                Status: "Failed",
                GatewayAuthority: authority,
                GatewayStatus: callbackStatus || reason,
                GatewayResponse: {
                  callbackStatus,
                  authority,
                  reason,
                },
              } as any,
            },
          );
        } catch (error) {
          strapi.log.error("Failed to mark ZarinPal transaction failed", error);
        }

        try {
          await strapi.entityService.update("api::order.order", orderId, {
            data: { Status: "Cancelled", external_source: "ZarinPal", external_id: authority },
          });
        } catch (error) {
          strapi.log.error("Failed to cancel ZarinPal order", error);
        }

        try {
          await releaseOrderReservation(strapi as any, Number(orderId), "Released");
        } catch {}

        try {
          await strapi.entityService.update("api::contract.contract", contractId, {
            data: { Status: "Cancelled", external_source: "ZarinPal", external_id: authority },
          });
        } catch (error) {
          strapi.log.error("Failed to cancel ZarinPal contract", error);
        }

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

      await clearCartAfterPayment(strapi, orderId);

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
        }
        try {
          await strapi.entityService.update("api::order.order", orderId!, {
            data: { Status: "Cancelled" },
          });
        } catch (err) {
          strapi.log.error("Failed to mark order cancelled (Saman)", err);
        }
        try {
          await releaseOrderReservation(strapi as any, Number(orderId), "Released");
        } catch {}
        if (contractId) {
          try {
            await strapi.entityService.update("api::contract.contract", contractId, {
              data: { Status: "Cancelled", external_source: "SamanKish" },
            });
          } catch (err) {
            strapi.log.error("Failed to cancel contract (Saman)", err);
          }
        }
        if (contractTransaction?.id) {
          try {
            await strapi.entityService.update(
              "api::contract-transaction.contract-transaction",
              contractTransaction.id,
              { data: { Status: "Failed" } },
            );
          } catch (err) {
            strapi.log.error("Failed to update contract transaction status (Saman)", err);
          }
        }
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
          }),
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
      const expectedAmountIrr =
        attempt?.Amount != null ? Number(attempt.Amount) : contractAmountIrr;

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
            await samanService.reverseTransaction({ refNum });
          } catch (reverseErr) {
            strapi.log.error("Saman reverse attempt failed (amount mismatch)", reverseErr);
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
          await samanService.reverseTransaction({ refNum });
        } catch (reverseErr) {
          strapi.log.error("Saman reverse attempt failed (invalid reservation)", reverseErr);
        }
        await markOrderCancelled("reservation_invalid");
        return ctx.redirect(
          buildPaymentResultRedirectUrl("issue", {
            orderId,
            code: "reservation_invalid_reversed",
          }),
        );
      }

      // Atomic one-time claim: only the caller that wins this guarded CAS
      // may proceed to consume stock and finalize the order/contract. A
      // losing claim means another (concurrent or replayed) callback for
      // this exact attempt already finalized it — idempotent replay, no
      // side effects. This is called standalone (not inside a DB
      // transaction) because it uses the raw connection pool directly, so a
      // later rollback would not undo it — claim durably first, then run
      // side effects.
      if (attempt?.id) {
        const claimed = await claimPaymentAttemptForSettlement(
          strapi,
          Number(attempt.id),
          "Succeeded",
        );
        if (!claimed) {
          const current: any = await strapi.entityService.findOne(
            "api::payment-attempt.payment-attempt",
            Number(attempt.id),
            { fields: ["Status"] } as any,
          );
          if (String(current?.Status) === "Succeeded") {
            strapi.log.info("Saman settlement already claimed by a concurrent/duplicate callback", {
              orderId,
              attemptId: attempt.id,
            });
            return ctx.redirect(buildPaymentResultRedirectUrl("success", { orderId }));
          }
          strapi.log.error("Saman payment attempt not claimable at settlement time", {
            orderId,
            attemptId: attempt.id,
            status: current?.Status,
          });
          return ctx.redirect(
            buildPaymentResultRedirectUrl("issue", { orderId, code: "attempt_not_claimable" }),
          );
        }
      } else {
        strapi.log.error(
          "Saman settlement proceeding without a payment_attempts row (legacy order predating attempt tracking)",
          { orderId, resNum: resNumRaw },
        );
      }

      // Stock handling:
      // - Reserved orders: consume reservation (Count-- and ReservedCount--) atomically
      // - Legacy orders: fallback to direct decrement
      const stockResult = await handlePostPaymentStock(strapi, orderId, "Saman", {
        requireReservation: true,
      });

      if (!stockResult.success) {
        // We already claimed the attempt as Succeeded above (money was
        // taken), but local stock consumption failed — this is ambiguous,
        // not a clean failure, so downgrade to "Unknown" rather than
        // asserting a false terminal state. Never write "Failed" here: a
        // successful claim must never be undone by a later local error.
        if (attempt?.id) {
          try {
            await updatePaymentAttempt(strapi, Number(attempt.id), {
              Status: "Unknown",
              failureCode: stockResult.expired ? "RESERVATION_EXPIRED" : "STOCK_CONSUME_FAILED",
              failureMessage:
                "Payment claimed but stock could not be consumed; needs reconciliation",
              lastReconciledAt: new Date(),
            });
          } catch (err) {
            strapi.log.error("Failed to downgrade Saman payment attempt after stock failure", err);
          }
        }
        if (stockResult.expired) {
          // Reservation expired -> reverse transaction (automatic refund) and inform user
          try {
            await releaseOrderReservation(strapi as any, Number(orderId), "Expired");
          } catch {}
          try {
            await samanService.reverseTransaction({ refNum });
          } catch (reverseErr) {
            strapi.log.error("Saman reverse attempt failed (expired reservation)", reverseErr);
          }
          await markOrderCancelled("reservation_expired");
          return ctx.redirect(
            buildPaymentResultRedirectUrl("issue", {
              orderId,
              code: "reservation_expired_reversed",
            }),
          );
        } else {
          // Consume failure -> reverse transaction and inform user
          try {
            await releaseOrderReservation(strapi as any, Number(orderId), "Expired");
          } catch {}
          try {
            await samanService.reverseTransaction({ refNum });
          } catch (reverseErr) {
            strapi.log.error("Saman reverse attempt failed (consume failure)", reverseErr);
          }
          await markOrderCancelled("reservation_consume_failed");
          return ctx.redirect(
            buildPaymentResultRedirectUrl("issue", {
              orderId,
              code: "reservation_consume_failed",
            }),
          );
        }
      } else if (stockResult.errors && stockResult.errors.length > 0) {
        return handleStockDecrementFailure(strapi, ctx, {
          orderId,
          stockErrors: stockResult.errors,
          refNum,
          paymentMethod: "SamanKish",
          externalSource: "SamanKish",
          // Preserve the resNum anchor (orders.external_id), not refNum — a
          // duplicate/retried callback must still resolve this order after
          // this write. RefNum is already durable on the contract-transaction
          // (TrackId) and contract, so nothing is lost.
          externalId: resNumRaw,
        });
      }

      // Only proceed to "Started" if no stock errors occurred. Deliberately
      // does NOT overwrite external_id with refNum: the correlation anchor
      // (orders.external_id = resNumRaw, set at initiation) must survive
      // settlement so a duplicate/retried callback for this same resNum
      // still resolves this order via the anchor lookup above, instead of
      // 400ing a paid customer who hits back/refresh. RefNum is already
      // durable on the contract-transaction (TrackId) and contract.
      try {
        await strapi.entityService.update("api::order.order", orderId, {
          data: {
            Status: "Started",
            external_source: "SamanKish",
          },
        });
      } catch (err) {
        strapi.log.error("Failed to update order status for Saman", err);
      }

      // Increment discount usage counter if discount was applied
      if (orderEntity?.DiscountCode) {
        await incrementDiscountUsageCounter(strapi, orderEntity.DiscountCode, orderId);
      }

      if (contractId) {
        try {
          await strapi.entityService.update("api::contract.contract", contractId, {
            data: {
              Status: "Confirmed",
              external_source: "SamanKish",
              external_id: refNum,
            },
          });
        } catch (err) {
          strapi.log.error("Failed to update contract for Saman", err);
        }
      }

      if (!contractTransaction && contractId) {
        try {
          contractTransaction = await strapi.entityService.create(
            "api::contract-transaction.contract-transaction",
            {
              data: {
                Type: "Gateway",
                Amount: contractAmountIrr,
                DiscountAmount: 0,
                Step: 1,
                Status: "Pending",
                TrackId: refNum,
                external_id: resNumRaw || refNum,
                external_source: "SamanKish",
                contract: contractId,
                Date: new Date(),
              },
            },
          );
        } catch (err) {
          strapi.log.error("Failed to create Saman contract transaction at verify", err);
        }
      }

      if (contractTransaction?.id) {
        try {
          await strapi.entityService.update(
            "api::contract-transaction.contract-transaction",
            contractTransaction.id,
            {
              data: {
                Status: "Success",
                TrackId: refNum,
                external_id: resNumRaw || contractTransaction.external_id,
                Amount: affectiveAmountIrr || contractAmountIrr,
              },
            },
          );
        } catch (err) {
          strapi.log.error("Failed to mark Saman contract transaction success", err);
        }
      }

      // Barcode generation is now a manual super-admin action.

      try {
        await strapi.entityService.create("api::order-log.order-log", {
          data: {
            order: orderId,
            Action: "Update",
            Description: "Saman gateway verify succeeded",
            Changes: {
              refNum,
              resNum: resNumRaw,
              resultCode: verifyResult.resultCode,
              detail,
            },
          },
        });
      } catch (err) {
        strapi.log.error("Failed to log Saman success", err);
      }

      await clearCartAfterPayment(strapi, orderId);

      return ctx.redirect(
        buildPaymentResultRedirectUrl("success", {
          orderId,
          transactionId: refNum || "",
        }),
      );
    }

    // Check if payment was successful (ResCode = 0) - Mellat
    //
    // Correlation anchor: RefId is minted by Mellat at PayRequest time and
    // echoed back to the customer's browser; payment_attempts.providerReference
    // stores that exact value for this order's specific attempt
    // (finalizeToOrder.ts). Neither bpVerifyRequest nor bpSettleRequest echo
    // back any identifier we can cross-check (official doc: bare ResCode
    // only), so this is the only local defense against an attacker supplying
    // an arbitrary OrderId/SaleOrderId in this unauthenticated callback.
    const mellatRefIdRaw = RefId !== undefined && RefId !== null ? String(RefId).trim() : "";
    const mellatCallbackOrderId = parseInt(String(OrderId ?? SaleOrderId ?? ""), 10);

    if (ResCode !== "0") {
      let failureAttempt: any = null;
      if (mellatRefIdRaw) {
        try {
          failureAttempt = await findPaymentAttemptByProviderReference(
            strapi,
            "mellat",
            mellatRefIdRaw,
          );
        } catch (err) {
          strapi.log.error(
            "Failed to locate Mellat payment attempt by RefId (failure callback)",
            err,
          );
        }
      }

      const correlatedOrderId = failureAttempt?.order?.id
        ? Number(failureAttempt.order.id)
        : undefined;

      if (
        !failureAttempt ||
        !correlatedOrderId ||
        (Number.isFinite(mellatCallbackOrderId) && mellatCallbackOrderId !== correlatedOrderId)
      ) {
        // Cannot correlate this failure to a known attempt/order — do not
        // mutate anything. A caller-supplied OrderId alone must never be
        // enough to cancel an order (Finding B).
        strapi.log.error(
          "Mellat failure callback could not be correlated to a known payment attempt; ignoring",
          {
            refId: mellatRefIdRaw,
            callbackOrderId: mellatCallbackOrderId,
            correlatedOrderId,
            ResCode,
          },
        );
        if (ResCode === "17") {
          ctx.redirect(buildPaymentResultRedirectUrl("cancelled", { reason: "user-cancelled" }));
        } else {
          ctx.redirect(
            buildPaymentResultRedirectUrl("failure", {
              error: `Payment failed with code: ${ResCode}`,
            }),
          );
        }
        return;
      }

      const orderId = correlatedOrderId;

      const currentOrder: any = await strapi.entityService.findOne("api::order.order", orderId, {
        fields: ["Status"],
        populate: { user: true },
      } as any);

      const alreadySettled =
        currentOrder && ["Started", "Shipment", "Done"].includes(String(currentOrder.Status));

      // Atomic claim to Failed: idempotent against duplicate failure
      // callbacks, and against racing a concurrent success (if the attempt
      // is already Succeeded, this claim loses and we must not cancel).
      const claimedFailed = alreadySettled
        ? false
        : failureAttempt?.id
        ? await claimPaymentAttemptForSettlement(strapi, Number(failureAttempt.id), "Failed")
        : true;

      if (alreadySettled || !claimedFailed) {
        strapi.log.info("Mellat failure callback ignored: order/attempt already finalized", {
          orderId,
          ResCode,
          currentStatus: currentOrder?.Status,
          attemptId: failureAttempt?.id,
        });
        if (ResCode === "17") {
          ctx.redirect(buildPaymentResultRedirectUrl("cancelled", { orderId, reason: "user-cancelled" }));
        } else {
          ctx.redirect(
            buildPaymentResultRedirectUrl("failure", {
              orderId,
              error: `Payment failed with code: ${ResCode}`,
            }),
          );
        }
        return;
      }

      // Log payment failure to user activity feed before cancelling
      try {
        const userId = currentOrder?.user?.id ? Number(currentOrder.user.id) : null;
        if (userId) {
          const activityService = strapi.service("api::user-activity.user-activity") as any;
          const reason = ResCode === "17" ? "لغو شده توسط کاربر" : "خطا در پرداخت";
          if (activityService?.logPaymentFailed) {
            await activityService.logPaymentFailed(userId, orderId, reason);
          }
        }
      } catch (activityError) {
        strapi.log.error("Failed to log payment failure to user activity", {
          orderId,
          error: (activityError as Error).message,
        });
      }

      try {
        await strapi.entityService.update("api::order.order", orderId, {
          data: { Status: "Cancelled" },
        });
        try {
          await releaseOrderReservation(strapi as any, Number(orderId), "Released");
        } catch {}
        strapi.log.info(`Order ${orderId} marked as Cancelled due to payment failure/cancellation`);
      } catch (updateError) {
        strapi.log.error(`Failed to update order ${orderId} status:`, updateError);
      }

      // Log the specific error/cancellation
      try {
        await strapi.entityService.create("api::order-log.order-log", {
          data: {
            order: orderId,
            Action: "Update",
            Description: "Gateway callback failure/cancellation",
            Changes: { ResCode, SaleOrderId, SaleReferenceId, RefId },
          },
        });
      } catch (e) {
        strapi.log.error("Failed to persist gateway failure log", e);
      }

      if (ResCode === "17") {
        strapi.log.info("Payment cancelled by user:", { orderId, ResCode });
        // User cancelled - redirect to frontend cancellation page
        ctx.redirect(buildPaymentResultRedirectUrl("cancelled", { orderId, reason: "user-cancelled" }));
      } else {
        strapi.log.error("Payment failed with ResCode:", ResCode);
        // Other payment failures - redirect to frontend failure page
        ctx.redirect(
          buildPaymentResultRedirectUrl("failure", {
            orderId,
            error: `Payment failed with code: ${ResCode}`,
          }),
        );
      }
      return;
    }

    // Idempotency check: Check if this Mellat callback has already been processed
    if (SaleReferenceId) {
      try {
        const existingTx = await strapi.entityService.findMany(
          "api::contract-transaction.contract-transaction",
          {
            filters: {
              external_source: "Mellat",
              external_id: String(SaleReferenceId),
              Status: "Success",
            },
            populate: { contract: { populate: { order: true } } },
            limit: 1,
          },
        );

        if (existingTx && existingTx.length > 0) {
          const existingOrderRelation: any = (existingTx[0] as any)?.contract?.order;
          const existingOrderId = existingOrderRelation
            ? Number(
                typeof existingOrderRelation === "object"
                  ? existingOrderRelation.id
                  : existingOrderRelation,
              )
            : undefined;
          strapi.log.info(
            `Mellat callback already processed (idempotency check): SaleReferenceId=${SaleReferenceId}, orderId=${existingOrderId}`,
            {
              saleReferenceId: String(SaleReferenceId),
              orderId: existingOrderId,
              existingTxId: existingTx[0].id,
            },
          );
          // Redirect to the transaction's own order, never a caller-supplied one.
          if (existingOrderId && !Number.isNaN(existingOrderId)) {
            return ctx.redirect(buildPaymentResultRedirectUrl("success", { orderId: existingOrderId }));
          }
          return ctx.badRequest("Callback already processed");
        }
      } catch (idempotencyErr) {
        strapi.log.error("Failed to check Mellat callback idempotency", idempotencyErr);
        // Continue processing if idempotency check fails
      }
    }

    if (!mellatRefIdRaw) {
      strapi.log.error("Mellat callback missing RefId; cannot correlate to a payment attempt", {
        OrderId,
        SaleOrderId,
        SaleReferenceId,
      });
      return ctx.badRequest("Invalid payment reference", {
        data: { success: false, error: "Invalid payment reference (Mellat)" },
      });
    }

    const attempt: any = await findPaymentAttemptByProviderReference(
      strapi,
      "mellat",
      mellatRefIdRaw,
    );
    const correlatedOrderId = attempt?.order?.id ? Number(attempt.order.id) : undefined;

    if (!attempt || !correlatedOrderId) {
      strapi.log.error("Mellat callback RefId does not match any known payment attempt", {
        refId: mellatRefIdRaw,
        callbackOrderId: mellatCallbackOrderId,
      });
      return ctx.badRequest("Invalid payment reference", {
        data: { success: false, error: "Invalid payment reference (Mellat)" },
      });
    }

    if (Number.isFinite(mellatCallbackOrderId) && mellatCallbackOrderId !== correlatedOrderId) {
      strapi.log.error(
        "Mellat callback OrderId does not match the order bound to this RefId; rejecting",
        { refId: mellatRefIdRaw, callbackOrderId: mellatCallbackOrderId, correlatedOrderId },
      );
      return ctx.badRequest("Invalid order reference", {
        data: { success: false, error: "Invalid order reference (Mellat)" },
      });
    }

    const orderId = correlatedOrderId;

    const orderForConsumedCheck: any = await strapi.entityService.findOne(
      "api::order.order",
      orderId,
      { fields: ["ReservationStatus"] } as any,
    );

    if (String(orderForConsumedCheck?.ReservationStatus) === "Consumed") {
      strapi.log.info("Mellat callback for already-consumed order; idempotent no-op", {
        orderId,
        refId: mellatRefIdRaw,
      });
      return ctx.redirect(buildPaymentResultRedirectUrl("success", { orderId }));
    }

    // Mellat: verify and settle
    const paymentService = strapi.service("api::payment-gateway.mellat-v3");
    const verificationResult = await paymentService.verifyTransaction({
      orderId: String(orderId),
      saleOrderId: SaleOrderId,
      saleReferenceId: SaleReferenceId,
    });

    if (verificationResult.success) {
      // Settle the transaction
      // Reservation check BEFORE settlement: if reservation expired, reverse payment and inform user.
      try {
        const orderForReservation: any = await strapi.entityService.findOne(
          "api::order.order",
          orderId,
          {
            fields: ["Status", "ReservationStatus", "ReservedUntil"],
            populate: { contract: true },
          } as any,
        );
        const reservationStatus = orderForReservation?.ReservationStatus;
        if (reservationStatus && reservationStatus !== "Consumed") {
          const until = orderForReservation?.ReservedUntil
            ? new Date(orderForReservation.ReservedUntil)
            : null;
          const orderCancelled = String(orderForReservation?.Status) === "Cancelled";
          const invalidReservation =
            reservationStatus !== "Reserved" ||
            orderCancelled ||
            !until ||
            until.getTime() < Date.now();

          if (invalidReservation) {
            try {
              await releaseOrderReservation(strapi as any, Number(orderId), "Expired");
            } catch {}

            try {
              await paymentService.reverseTransaction({
                orderId: String(orderId),
                saleOrderId: SaleOrderId,
                saleReferenceId: SaleReferenceId,
              });
            } catch (reverseErr) {
              strapi.log.error("Mellat reversal attempt failed (expired reservation)", reverseErr);
            }

            try {
              await strapi.entityService.update("api::order.order", orderId, {
                data: { Status: "Cancelled" },
              });
            } catch {}
            const contractId =
              typeof orderForReservation?.contract === "object" && orderForReservation.contract
                ? orderForReservation.contract.id
                : orderForReservation?.contract;
            if (contractId) {
              try {
                await strapi.entityService.update("api::contract.contract", contractId, {
                  data: { Status: "Cancelled", external_source: "Mellat" },
                });
              } catch {}
            }

            try {
              await strapi.entityService.create("api::order-log.order-log", {
                data: {
                  order: orderId,
                  Action: "Update",
                  Description: "Reservation expired; Mellat payment reversed before settlement",
                  Changes: { SaleOrderId, SaleReferenceId, ResCode, RefId },
                },
              });
            } catch {}

            return ctx.redirect(
              buildPaymentResultRedirectUrl("issue", {
                orderId,
                code: "reservation_expired_reversed",
              }),
            );
          }
        }
      } catch (reservationErr) {
        strapi.log.error("Failed to validate reservation before Mellat settlement", reservationErr);
      }

      const settlementResult = await paymentService.settleTransaction({
        orderId: String(orderId),
        saleOrderId: SaleOrderId,
        saleReferenceId: SaleReferenceId,
      });

      if (settlementResult.success) {
        // Atomic one-time claim: only the caller that wins this guarded CAS
        // may proceed to consume stock and finalize the order/contract. A
        // losing claim means another (concurrent or replayed) callback for
        // this exact attempt already finalized it — idempotent replay, no
        // side effects. Called standalone (not inside a DB transaction)
        // because it uses the raw connection pool directly.
        if (attempt?.id) {
          const claimed = await claimPaymentAttemptForSettlement(
            strapi,
            Number(attempt.id),
            "Succeeded",
          );
          if (!claimed) {
            const current: any = await strapi.entityService.findOne(
              "api::payment-attempt.payment-attempt",
              Number(attempt.id),
              { fields: ["Status"] } as any,
            );
            if (String(current?.Status) === "Succeeded") {
              strapi.log.info(
                "Mellat settlement already claimed by a concurrent/duplicate callback",
                { orderId, attemptId: attempt.id },
              );
              return ctx.redirect(buildPaymentResultRedirectUrl("success", { orderId }));
            }
            strapi.log.error("Mellat payment attempt not claimable at settlement time", {
              orderId,
              attemptId: attempt.id,
              status: current?.Status,
            });
            return ctx.redirect(
              buildPaymentResultRedirectUrl("issue", { orderId, code: "attempt_not_claimable" }),
            );
          }
        } else {
          strapi.log.error(
            "Mellat settlement proceeding without a payment_attempts row (legacy order predating attempt tracking)",
            { orderId, refId: mellatRefIdRaw },
          );
        }

        // Update order status to Started (Paid)
        // Stock handling:
        // - Reserved orders: consume reservation (Count-- and ReservedCount--) atomically
        // - Legacy orders: fallback to direct decrement
        const stockResult = await handlePostPaymentStock(strapi, orderId, "Mellat", {
          requireReservation: true,
        });
        const stockErrors =
          stockResult.errors && stockResult.errors.length > 0
            ? stockResult.errors
            : stockResult.success
            ? []
            : [
                {
                  error: stockResult.expired ? "Reservation expired" : "Stock decrement failed",
                },
              ];

        if (!stockResult.success || stockErrors.length > 0) {
          // We already claimed the attempt as Succeeded above (money was
          // taken), but local stock consumption failed — ambiguous, not a
          // clean failure. Downgrade to "Unknown" rather than asserting a
          // false terminal state; never write "Failed" after a successful
          // claim.
          if (attempt?.id) {
            try {
              await updatePaymentAttempt(strapi, Number(attempt.id), {
                Status: "Unknown",
                failureCode: stockResult.expired ? "RESERVATION_EXPIRED" : "STOCK_CONSUME_FAILED",
                failureMessage:
                  "Payment claimed but stock could not be consumed; needs reconciliation",
                lastReconciledAt: new Date(),
              });
            } catch (err) {
              strapi.log.error(
                "Failed to downgrade Mellat payment attempt after stock failure",
                err,
              );
            }
          }
          const referenceId = SaleReferenceId || RefId || OrderId || SaleOrderId;
          return handleStockDecrementFailure(strapi, ctx, {
            orderId,
            stockErrors,
            refNum: referenceId,
            paymentMethod: "Mellat",
            externalSource: "Mellat",
            externalId: SaleReferenceId || referenceId,
          });
        }

        await strapi.entityService.update("api::order.order", orderId, {
          data: {
            Status: "Started",
          },
        });

        const settledOrder = (await strapi.entityService.findOne("api::order.order", orderId, {
          populate: { contract: true },
        } as any)) as any;

        // Record the settled transaction before anything that can fail, so a
        // replayed callback is caught by the idempotency check above.
        await recordMellatSettlement(strapi, {
          orderId,
          contract: settledOrder?.contract,
          saleReferenceId: SaleReferenceId,
          refId: RefId,
        });

        if (settledOrder?.contract) {
          const settledContractId =
            typeof settledOrder.contract === "object"
              ? settledOrder.contract.id
              : settledOrder.contract;
          try {
            await strapi.entityService.update("api::contract.contract", settledContractId, {
              data: {
                Status: "Confirmed",
                external_source: "Mellat",
                external_id: String(SaleReferenceId ?? RefId ?? ""),
              },
            });
          } catch (err) {
            strapi.log.error("Failed to update contract for Mellat", err);
          }
        }

        // Increment discount usage counter if discount was applied
        try {
          if (settledOrder?.DiscountCode) {
            await incrementDiscountUsageCounter(strapi, settledOrder.DiscountCode, orderId);
          }
        } catch (err) {
          strapi.log.error("Failed to increment discount for Mellat order", err);
        }

        // Barcode generation is now a manual super-admin action.

        strapi.log.info(`Payment successful for Order ${orderId}:`, {
          orderId,
          ResCode,
          SaleReferenceId,
          settlementResult: settlementResult.resCode,
        });

        // Audit log for successful payment callback
        try {
          await strapi.entityService.create("api::order-log.order-log", {
            data: {
              order: orderId,
              Action: "Update",
              Description: "Gateway callback success (verify+settle)",
              Changes: { ResCode, SaleOrderId, SaleReferenceId, RefId },
            },
          });
        } catch (e) {
          strapi.log.error("Failed to persist gateway success log", e);
        }

        await clearCartAfterPayment(strapi, orderId);

        // Redirect to frontend success page
        ctx.redirect(buildPaymentResultRedirectUrl("success", { orderId }));
      } else {
        // Settlement failed after a genuine verify success — ambiguous
        // (bank ResCode 45 can mean "already settled elsewhere"), so mark
        // the attempt "Unknown" for reconciliation rather than "Failed".
        // bpReversalRequest only works same-day and pre-settle per the
        // official doc, so no automatic reversal is attempted here; this
        // intentionally routes to manual reconciliation.
        console.error("Payment settlement failed:", settlementResult.error);
        if (attempt?.id) {
          try {
            await updatePaymentAttempt(strapi, Number(attempt.id), {
              Status: "Unknown",
              failureCode: "SETTLE_FAILED",
              failureMessage: settlementResult.error || "Settlement failed",
              lastReconciledAt: new Date(),
            });
          } catch (err) {
            strapi.log.error(
              "Failed to mark Mellat payment attempt Unknown after settle failure",
              err,
            );
          }
        }
        try {
          await strapi.entityService.create("api::order-log.order-log", {
            data: {
              order: orderId,
              Action: "Update",
              Description: "Gateway settlement failed",
              Changes: {
                error: settlementResult.error,
                SaleOrderId,
                SaleReferenceId,
                RefId,
              },
            },
          });
        } catch (e) {
          strapi.log.error("Failed to persist gateway settlement failure log", e);
        }
        ctx.redirect(
          buildPaymentResultRedirectUrl("failure", {
            orderId,
            error: settlementResult.error || "Settlement failed",
          }),
        );
      }
    } else {
      // Verification failed. Correlation already happened above, so
      // `orderId`/`attempt` are trustworthy — no order mutation here (this
      // mirrors prior behavior; the reservation expiry job reclaims
      // genuinely-abandoned stock), just a best-effort attempt claim so a
      // concurrent success can never be undone by this branch.
      console.error("Payment verification failed:", verificationResult.error);
      if (attempt?.id) {
        try {
          await claimPaymentAttemptForSettlement(strapi, Number(attempt.id), "Failed");
        } catch (err) {
          strapi.log.error("Failed to claim Mellat payment attempt after verify failure", err);
        }
      }
      try {
        await strapi.entityService.create("api::order-log.order-log", {
          data: {
            order: orderId,
            Action: "Update",
            Description: "Gateway verification failed",
            Changes: {
              error: verificationResult.error,
              SaleOrderId,
              SaleReferenceId,
              RefId,
            },
          },
        });
      } catch (e) {
        strapi.log.error("Failed to persist gateway verification failure log", e);
      }

      // Redirect to frontend failure page
      ctx.redirect(
        buildPaymentResultRedirectUrl("failure", {
          orderId,
          error: verificationResult.error || "Verification failed",
        }),
      );
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
