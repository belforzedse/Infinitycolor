/**
 * cart service
 */

import * as Sentry from "@sentry/node";
import { factories } from "@strapi/strapi";
import { getOrCreateUserCart } from "./lib/get-user-cart";
import { createOrderAndItems } from "./lib/order";
import { computeCouponDiscount, findFirstActiveGeneralDiscount } from "./lib/discounts";
import { claimLimitedDiscountUsage } from "./lib/discount-claim";
import { computeTotals } from "./lib/financials";
import { createContract } from "./lib/contract";
import { reserveStockAtomic } from "./lib/stock";
import {
  lockReserveGroup,
  RESERVE_GROUP_STATES,
  ReserveWindowClosedError,
  UID as RESERVE_GROUP_UID,
} from "../../reserve-group/lib/reserve-group";
import { addCartItemOp } from "./ops/addCartItem";
import { updateCartItemOp } from "./ops/updateCartItem";
import { removeCartItemOp } from "./ops/removeCartItem";
import { checkCartStockOp } from "./ops/checkCartStock";
import { createCheckoutQuote, type CheckoutQuote } from "./lib/checkout-quote";
import {
  createPaymentAttempt,
  findPaymentAttempt,
} from "../../payment-attempt/services/payment-attempt";
import {
  generateSnappayCallbackNonce,
  generateSnappayTransactionId,
  hashSnappayCallbackNonce,
} from "../../payment-gateway/services/snappay-security";
import { snappayProviderPaymentIsUnresolved } from "../../payment-gateway/services/snappay-generation";
import { redactSensitive } from "../../../utils/redactSensitive";

// A dead attempt (customer backed out of the gateway, or it expired) must never be
// replayed as if it were still live -- the browser can still hold its id in
// localStorage long after the gateway/orchestrator marked it terminal, and the
// customer's next tap must start a fresh attempt instead of being handed the same
// failure forever. "Unknown" is not terminal: that is the unreadable-status hold
// where checkout must reuse the same attempt so initiate can GET /status before
// any second token. A local Failed/Cancelled/Expired SnappPay row is also not
// terminal while a provider generation may still be live.
const TERMINAL_PAYMENT_ATTEMPT_STATUSES = new Set(["Failed", "Cancelled", "Expired"]);

function isSnappayReplay(replay: { Gateway?: unknown }): boolean {
  return String(replay.Gateway || "").toLowerCase() === "snappay";
}

function existingAttemptBlocksReplacement(
  replay: {
    Status?: unknown;
    quoteHash?: unknown;
    Gateway?: unknown;
    providerStatus?: unknown;
    providerResponse?: unknown;
    providerReference?: unknown;
  },
  gateway: string,
  expectedQuoteHash: string,
): "replay" | "conflict" | "in_progress" {
  if (isSnappayReplay(replay) && snappayProviderPaymentIsUnresolved(replay)) {
    if (gateway !== "snappay") return "in_progress";
    return "replay";
  }
  if (
    TERMINAL_PAYMENT_ATTEMPT_STATUSES.has(String(replay.Status || "")) ||
    String(replay.quoteHash) !== expectedQuoteHash ||
    String(replay.Gateway) !== gateway
  ) {
    return "conflict";
  }
  return "replay";
}

export default factories.createCoreService("api::cart.cart", ({ strapi }) => ({
  async getUserCart(userId: number) {
    return getOrCreateUserCart(strapi as any, userId);
  },

  async addCartItem(cartId: number, productVariationId: number, count: number = 1) {
    return addCartItemOp(strapi as any, cartId, productVariationId, count);
  },

  // `ownerUserId` is a required argument on both of these: a client-supplied cart-item
  // id is only a candidate, and ownership is what authorizes the mutation.
  async updateCartItem(cartItemId: number, count: number, ownerUserId: number) {
    return updateCartItemOp(strapi as any, cartItemId, count, ownerUserId);
  },

  async removeCartItem(cartItemId: number, ownerUserId: number) {
    return removeCartItemOp(strapi as any, cartItemId, ownerUserId);
  },

  async clearCart(userId: number) {
    const cart = await getOrCreateUserCart(strapi as any, userId);
    if (!cart?.id) {
      return { success: true };
    }

    const cartItems = cart.cart_items || [];
    if (cartItems.length > 0) {
      // Batch delete to avoid N+1 query problem
      try {
        const itemIds = cartItems.map((item: any) => item.id).filter((id: any) => id);
        if (itemIds.length > 0) {
          await strapi.db
            .query("api::cart-item.cart-item")
            .deleteMany({ where: { id: { $in: itemIds } } });
        }
      } catch (err) {
        strapi.log.error("Failed to batch delete cart items during clearCart", {
          cartId: cart.id,
          itemCount: cartItems.length,
          error: err,
        });
        // Fallback to individual deletes if batch fails
        for (const item of cartItems) {
          try {
            await strapi.entityService.delete("api::cart-item.cart-item", item.id);
          } catch (itemErr) {
            strapi.log.error("Failed to remove cart item during clearCart fallback", {
              cartItemId: item.id,
              error: itemErr,
            });
          }
        }
      }
    }

    try {
      await strapi.entityService.update("api::cart.cart", cart.id, {
        data: { Status: "Empty" },
      });
    } catch (err) {
      strapi.log.error("Failed to update cart status during clearCart", err);
    }

    return { success: true };
  },

  async checkCartStock(userId: number) {
    return checkCartStockOp(strapi as any, userId);
  },

  async finalizeCartToOrder(userId: number, shippingData: any) {
    const gateway = String(shippingData?.gateway || "")
      .trim()
      .toLowerCase();
    const managesPaymentAttempt = gateway !== "";
    const attemptId = String(shippingData?.attemptId || "").trim();
    const expectedQuoteHash = String(shippingData?.quoteHash || "").trim();

    if (managesPaymentAttempt) {
      if (!attemptId || attemptId.length > 128) {
        return {
          success: false,
          status: 400,
          errorCode: "CHECKOUT_ATTEMPT_REQUIRED",
          message: "Checkout attempt id is required",
        };
      }
      if (!expectedQuoteHash) {
        return {
          success: false,
          status: 400,
          errorCode: "CHECKOUT_QUOTE_REQUIRED",
          message: "Checkout quote is required",
        };
      }

      const replay = await findPaymentAttempt(strapi as any, userId, attemptId);
      if (replay) {
        const decision = existingAttemptBlocksReplacement(replay, gateway, expectedQuoteHash);
        if (decision === "in_progress") {
          return {
            success: false,
            status: 409,
            errorCode: "PAYMENT_IN_PROGRESS",
            message: "پرداخت قبلی هنوز در حال بررسی است. لطفاً چند لحظه بعد وضعیت سفارش را بررسی کنید.",
          };
        }
        if (decision === "conflict") {
          return {
            success: false,
            status: 409,
            errorCode: "CHECKOUT_ATTEMPT_CONFLICT",
            message: "شناسه پرداخت قبلاً برای پیش‌فاکتور دیگری استفاده شده است",
          };
        }
        return {
          success: true,
          replayed: true,
          order: replay.order,
          contract: replay.contract,
          paymentAttempt: replay,
          financialSummary: replay.quoteSnapshot?.financialSummary,
        };
      }
    }

    // First check stock
    const stockCheck = await this.checkCartStock(userId);

    if (!stockCheck.valid) {
      // Returned without an errorCode and with an English message, so the
      // storefront cannot map it and falls back to the generic banner. Reported
      // here because it never reaches the catch block below, which means it is
      // otherwise invisible in both Sentry and the order-log table.
      try {
        Sentry.captureMessage("checkout.stock_changed_before_payment", {
          level: "warning",
          tags: { area: "checkout", stage: "stockCheck", errorCode: "STOCK_CHANGED", gateway: gateway || "none" },
          extra: {
            userId,
            removedCount: stockCheck.itemsRemoved?.length || 0,
            adjustedCount: stockCheck.itemsAdjusted?.length || 0,
          },
        });
      } catch (reportError) {
        strapi.log.error("Failed to report checkout stock change", reportError);
      }
      return {
        success: false,
        message: "Stock issues prevent order creation",
        itemsRemoved: stockCheck.itemsRemoved,
        itemsAdjusted: stockCheck.itemsAdjusted,
        cart: stockCheck.cart,
      };
    }

    const cart = stockCheck.cart || (await this.getUserCart(userId));

    if (!cart.cart_items || cart.cart_items.length === 0) {
      return { success: false, message: "Cannot create order from empty cart" };
    }

    let checkoutQuote: CheckoutQuote | null = null;
    if (managesPaymentAttempt) {
      checkoutQuote = await createCheckoutQuote(strapi as any, userId, {
        cart,
        shippingId: shippingData.shippingId,
        shippingCost: shippingData.shippingCost,
        discountCode: shippingData.discountCode,
        gateway,
        reserveGroupId: shippingData.reserveGroupId,
      });
      if (checkoutQuote.quoteHash !== expectedQuoteHash) {
        return {
          success: false,
          status: 409,
          errorCode: "CHECKOUT_QUOTE_CHANGED",
          message: "قیمت یا موجودی سبد خرید تغییر کرده است",
          quote: checkoutQuote,
        };
      }
      if (gateway === "snappay") {
        await strapi
          .service("api::payment-gateway.snappay-orchestrator")
          .checkEligibility(Math.round(checkoutQuote.financialSummary.total * 10));
      }
    }

    const snappayInitiation =
      gateway === "snappay"
        ? {
            transactionId: generateSnappayTransactionId(),
            callbackNonce: generateSnappayCallbackNonce(),
          }
        : null;

    try {
      // Start transaction to ensure all operations succeed or fail together
      const result = await strapi.db.transaction(async ({ trx }) => {
        if (managesPaymentAttempt) {
          const replay = await findPaymentAttempt(strapi as any, userId, attemptId, trx);
          if (replay) {
            const decision = existingAttemptBlocksReplacement(replay, gateway, expectedQuoteHash);
            if (decision === "in_progress") {
              throw new Error("PAYMENT_IN_PROGRESS: Unresolved SnappPay payment is still live");
            }
            if (decision === "conflict") {
              throw new Error(
                "CHECKOUT_ATTEMPT_CONFLICT: Attempt id was already used for another quote",
              );
            }
            return {
              success: true,
              replayed: true,
              order: replay.order,
              contract: replay.contract,
              paymentAttempt: replay,
              financialSummary: replay.quoteSnapshot?.financialSummary,
            };
          }
        }

        // Using enum values explicitly
        type OrderStatus = "Paying" | "Started" | "Shipment" | "Done" | "Returned" | "Cancelled";
        type OrderType = "Manual" | "Automatic";
        type ContractStatus = "Not Ready" | "Confirmed" | "Finished" | "Failed" | "Cancelled";
        type ContractType = "Cash" | "Credit";

        // Must exceed the longest gateway payment-session lifetime. If a
        // reservation expires while the customer can still complete payment, the
        // expiry job releases the stock and the subsequent successful charge has
        // to be reversed. SAMAN_TOKEN_EXPIRY_MIN is 20, so 15 was under-set.
        const reservationTtlMinutes = Number(process.env.STOCK_RESERVATION_TTL_MINUTES || 30);
        const reservationTtlMs = Number.isFinite(reservationTtlMinutes)
          ? Math.max(1, reservationTtlMinutes) * 60 * 1000
          : 30 * 60 * 1000;
        const reservedUntil = new Date(Date.now() + reservationTtlMs);

        // Validate reservation date is in the future
        const reservation = { status: "Reserved" as const, until: reservedUntil };
        if (reservation.until <= new Date()) {
          throw new Error("INVALID_RESERVATION: Reservation date must be in the future");
        }

        // Shipping is calculated and validated in the checkout controller.
        let finalShippingCost =
          shippingData.reserveOrderData?.isMerge === true
            ? 0
            : Math.max(0, Math.round(Number(shippingData.shippingCost || 0)));

        // Reserve shipping: attach to the caller's existing group, or open a new
        // one. A brand-new group is created PendingActivation with NO deadline --
        // the 48h clock starts at successful payment (see activateGroupOnPayment),
        // so gateway time is never billed to the customer's window and an
        // abandoned checkout can never leave an attachable group behind.
        let reserveGroupId: string | undefined;
        let reserveExpiresAt: Date | undefined;
        let reserveGroupRowId: number | undefined;
        const isReserveOrder = !!shippingData.reserveShipping || !!shippingData.reserveOrderData;
        if (shippingData.reserveOrderData?.isMerge) {
          reserveGroupId = shippingData.reserveOrderData.reserveGroupId;
          reserveGroupRowId = shippingData.reserveOrderData.reserveGroupRowId;

          // The attach-vs-expire race is settled here. Locking the group row for
          // the rest of this transaction serialises us against the expiry job's
          // CAS update, so exactly one of the two wins; re-reading under the lock
          // means we never bind a child to a window that has just closed.
          if (reserveGroupRowId) {
            await lockReserveGroup(strapi as any, reserveGroupRowId, trx);
            const locked = await strapi.db.query(RESERVE_GROUP_UID).findOne({
              where: { id: reserveGroupRowId },
            });
            const stillOpen =
              locked?.State === RESERVE_GROUP_STATES.active &&
              locked?.expiresAt != null &&
              new Date(locked.expiresAt) > new Date();
            if (!stillOpen) {
              throw new ReserveWindowClosedError();
            }
            reserveExpiresAt = new Date(locked.expiresAt);
          }
          if (!reserveExpiresAt) {
            const raw = shippingData.reserveOrderData.reserveExpiresAt;
            if (raw != null) {
              const d = new Date(raw as string | number | Date);
              reserveExpiresAt = Number.isNaN(d.getTime()) ? undefined : d;
            }
          }
        } else if (shippingData.reserveShipping) {
          const { randomUUID } = await import("node:crypto");
          reserveGroupId = randomUUID();
          const createdGroup = await strapi.db.query(RESERVE_GROUP_UID).create({
            data: {
              groupKey: reserveGroupId,
              owner: userId,
              State: RESERVE_GROUP_STATES.pendingActivation,
              lastActivityAt: new Date(),
              ShippingCostPaid: finalShippingCost,
              ShippingMethodCode: shippingData.shippingMethodCode
                ? String(shippingData.shippingMethodCode)
                : undefined,
              ShippingMethodTitle: shippingData.shippingMethodTitle
                ? String(shippingData.shippingMethodTitle)
                : undefined,
              shipping: shippingData.shippingId || undefined,
              delivery_address: shippingData.addressId || undefined,
            },
            ...(trx ? { transacting: trx } : {}),
          });
          reserveGroupRowId = createdGroup?.id;
        }

        // Create new order with enum values
        const orderData = {
          user: userId,
          Status: "Paying" as OrderStatus,
          Date: new Date(),
          Type: "Automatic" as OrderType,
          shipping: shippingData.shippingId,
          ShippingCost: finalShippingCost,
          Description: shippingData.description || "",
          Note: shippingData.note || "",
          delivery_address: shippingData.addressId || undefined,
        };

        // Create order and items with transaction context for atomicity
        const { order, subtotal, createdItems } = await createOrderAndItems(
          strapi as any,
          userId,
          cart,
          finalShippingCost,
          shippingData.shippingId,
          shippingData.description,
          shippingData.note,
          shippingData.addressId,
          reservation,
          trx,
          isReserveOrder && reserveGroupId
            ? { reserveGroupId, reserveExpiresAt, reserveGroupRowId }
            : undefined,
          {
            code: shippingData.shippingMethodCode,
            title: shippingData.shippingMethodTitle,
          },
          shippingData.analyticsCorrelationId
            ? { analyticsCorrelationId: String(shippingData.analyticsCorrelationId) }
            : undefined,
        );

        strapi.log.info("Order and items created successfully", {
          orderId: order.id,
          itemsCreated: createdItems.length,
          subtotal,
        });

        // Reserve stock for all items (high-load safe; rolls back if any reservation fails)
        // Aggregate quantities by stockId to avoid redundant reserveStockAtomic calls
        const stockQuantityMap = new Map<number, number>();

        for (const item of cart.cart_items || []) {
          const stockId = item?.product_variation?.product_stock?.id;
          const quantity = Number(item?.Count || 0);

          if (
            Number.isFinite(stockId) &&
            stockId > 0 &&
            Number.isFinite(quantity) &&
            quantity > 0
          ) {
            const numericStockId = Number(stockId);
            const currentQuantity = stockQuantityMap.get(numericStockId) || 0;
            stockQuantityMap.set(numericStockId, currentQuantity + quantity);
          }
        }

        // Sort by stockId for deadlock-safe ordering, then reserve aggregated quantities
        const aggregatedReservations = Array.from(stockQuantityMap.entries())
          .map(([stockId, quantity]) => ({ stockId, quantity }))
          .sort((a, b) => a.stockId - b.stockId);

        for (const r of aggregatedReservations) {
          const reserveRes = await reserveStockAtomic(strapi as any, r.stockId, r.quantity, trx);
          if (!reserveRes.success) {
            throw new Error(`STOCK_RESERVATION_FAILED: ${reserveRes.error || "reserve_failed"}`);
          }
        }

        // Always compute and persist order shipping weight from items (in grams)
        let totalWeight = 0;
        for (const item of cart.cart_items) {
          const product = item?.product_variation?.product;
          const weight = Number(product?.Weight ?? 100) || 100;
          const count = Number(item?.Count || 0);
          totalWeight += weight * count;
        }
        if (totalWeight <= 0) totalWeight = 100;
        try {
          await strapi.entityService.update("api::order.order", order.id, {
            data: { ShippingWeight: totalWeight } as any,
          });
        } catch (_) {}

        /**
         * Automatic Anipo shipping overrides disabled.
         * Leaving previous implementation commented for future reference.
         */
        /*
        if (Number(shippingData.shippingId) !== 4) {
          if (shippingData.addressId) {
            const address: any = await strapi.entityService.findOne(
              "api::local-user-address.local-user-address",
              Number(shippingData.addressId),
              {
                populate: {
                  shipping_city: { populate: { shipping_province: true } },
                },
              }
            );
            const cityCode = Number(address?.shipping_city?.Code || 0);
            if (cityCode) {
              const anipo: any = strapi.service("api::shipping.anipo");
              const preview = await anipo.barcodePrice({
                cityCode,
                weight: totalWeight,
                sum: subtotal,
                isnonstandard: 0,
                smsservice: 0,
              });
              if (preview?.ok && typeof preview.price === "number") {
                finalShippingCost = Math.max(0, Math.floor(preview.price));
                await strapi.entityService.update(
                  "api::order.order",
                  order.id,
                  {
                    data: { ShippingCost: finalShippingCost },
                  }
                );
              } else {
                try {
                  await strapi.entityService.create(
                    "api::order-log.order-log",
                    {
                      data: {
                        order: order.id,
                        Action: "Update",
                        Description: `Anipo shipping preview unavailable/skipped: ${String(
                          preview?.error || "no_price"
                        )}`,
                        PerformedBy: String(userId),
                      },
                    }
                  );
                } catch (_) {}
              }
            }
          }
        }
        */

        let discountAmount = checkoutQuote?.financialSummary.discount || 0;
        let discountCode: string | undefined = checkoutQuote?.discountCode;
        let appliedGeneralDiscountId: number | undefined = checkoutQuote?.appliedGeneralDiscountId;

        if (!checkoutQuote && shippingData?.discountCode) {
          discountCode = String(shippingData.discountCode);
          try {
            discountAmount = await computeCouponDiscount(
              strapi as any,
              userId,
              discountCode,
              subtotal,
              cart.cart_items,
              shippingData?.shippingId,
            );
          } catch (discountError: any) {
            // Discount validation failed - throw error to prevent order creation
            const errorMsg = discountError.message || "Discount validation failed";
            throw new Error(errorMsg);
          }
        }

        // If no coupon applied, find active general discounts
        if (!checkoutQuote && !discountAmount) {
          const generalDiscounts = await findFirstActiveGeneralDiscount(strapi as any);
          for (const discount of generalDiscounts) {
            const d: any = discount;
            if (d.MinimumAmount <= subtotal) {
              appliedGeneralDiscountId = d.id;
              if (d.IsPercentage) {
                discountAmount = (subtotal * d.Amount) / 100;
                if (d.MaxAmount && discountAmount > d.MaxAmount) {
                  discountAmount = d.MaxAmount;
                }
              } else {
                discountAmount = d.Amount;
              }
              break;
            }
          }
        }

        const totals =
          checkoutQuote?.financialSummary ||
          computeTotals(subtotal, discountAmount, finalShippingCost);

        const contract = await createContract(
          strapi as any,
          userId,
          Number(order.id),
          totals.total,
          0,
          trx,
        );

        strapi.log.info("Contract created successfully", {
          contractId: contract.id,
          amount: totals.total,
          orderId: order.id,
        });

        // Persist discount metadata for admin adjustment flows
        await strapi.db.query("api::order.order").update({
          where: { id: order.id },
          data: {
            contract: contract.id,
            ShippingCost: finalShippingCost,
            DiscountCode: discountCode,
            AppliedGeneralDiscountId: appliedGeneralDiscountId,
            AppliedDiscountAmount: Math.round(discountAmount),
          },
          ...(trx ? { transacting: trx } : {}),
        });

        // Reserve the limited-coupon usage in the same transaction that just made the
        // discounted order durable. Everything the gateway will be asked to charge —
        // order, contract amount, payment attempt — commits with the claim or not at
        // all, so two concurrent checkouts can never both be redirected holding the
        // last remaining usage. Throws DISCOUNT_USAGE_EXHAUSTED when the cap is reached.
        await claimLimitedDiscountUsage(strapi as any, {
          orderId: Number(order.id),
          code: discountCode,
          trx,
        });

        const paymentAttempt = managesPaymentAttempt
          ? await createPaymentAttempt(
              strapi as any,
              {
                attemptId,
                quoteHash: expectedQuoteHash,
                quoteSnapshot: checkoutQuote,
                Status: "Created",
                Gateway: gateway,
                Amount: Math.round(totals.total * 10),
                user: userId,
                order: order.id,
                contract: contract.id,
                ...(snappayInitiation
                  ? {
                      providerReference: snappayInitiation.transactionId,
                      providerStatus: "CREATED",
                      callbackNonceHash: hashSnappayCallbackNonce(snappayInitiation.callbackNonce),
                      // Kept so a replayed initiation can rebuild the same return
                      // URL. Private in the schema, so it never leaves the server.
                      callbackNonce: snappayInitiation.callbackNonce,
                    }
                  : {}),
              },
              trx,
            )
          : undefined;

        if (snappayInitiation && paymentAttempt) {
          const gatewayRecord: any = await strapi.db
            .query("api::payment-gateway.payment-gateway")
            .findOne({
              where: {
                $or: [{ Title: { $containsi: "snapp" } }, { Title: { $containsi: "اسنپ" } }],
              },
              ...(trx ? { transacting: trx } : {}),
            } as any);
          if (!gatewayRecord?.id) {
            throw new Error(
              "SNAPPAY_GATEWAY_RECORD_MISSING: Enable the SnappPay gateway before checkout",
            );
          }
          await strapi.db.query("api::contract-transaction.contract-transaction").create({
            data: {
              Type: "Gateway",
              Amount: Math.round(totals.total * 10),
              DiscountAmount: Math.round(totals.discount * 10),
              Step: 1,
              Status: "Pending",
              TrackId: null,
              GatewayStatus: "CREATED",
              GatewayResponse: {
                endpoint: "token",
                successful: false,
                initialized: true,
              },
              external_id: snappayInitiation.transactionId,
              external_source: "SnappPay",
              contract: contract.id,
              payment_gateway: gatewayRecord.id,
              Date: new Date(),
            },
            ...(trx ? { transacting: trx } : {}),
          } as any);
          await strapi.db.query("api::contract.contract").update({
            where: { id: contract.id },
            data: {
              Type: "Credit",
              external_source: "SnappPay",
              external_id: snappayInitiation.transactionId,
            },
            ...(trx ? { transacting: trx } : {}),
          } as any);
        }

        // Note: Do not clear the cart here. Cart will be cleared only after
        // a successful payment gateway request in the controller.

        return {
          success: true,
          order,
          contract,
          paymentAttempt,
          ...(snappayInitiation ? { snappayCallbackNonce: snappayInitiation.callbackNonce } : {}),
          financialSummary: totals,
        };
      });

      return result;
    } catch (error: any) {
      if (managesPaymentAttempt) {
        const replay = await findPaymentAttempt(strapi as any, userId, attemptId).catch(() => null);
        if (replay && existingAttemptBlocksReplacement(replay, gateway, expectedQuoteHash) === "replay") {
          return {
            success: true,
            replayed: true,
            order: replay.order,
            contract: replay.contract,
            paymentAttempt: replay,
            financialSummary: replay.quoteSnapshot?.financialSummary,
          };
        }
      }

      // Enhanced error logging with full context
      const errorContext = {
        userId,
        cartId: cart?.id,
        itemCount: cart?.cart_items?.length || 0,
        shippingData,
        errorMessage: error.message,
        errorStack: error.stack,
        errorName: error.name,
      };
      const safeErrorContext = redactSensitive(errorContext);

      strapi.log.error("Order creation failed:", safeErrorContext);
      console.error("=== ORDER CREATION FAILED ===");
      console.error("Error Message:", error.message);
      console.error("Error Code:", error.message?.split(":")[0]);
      console.error("Full Context:", JSON.stringify(safeErrorContext, null, 2));

      // Parse error message to extract error code and details
      const errorMessage = error.message || "Unknown error";
      let errorCode = "UNKNOWN_ERROR";
      let userMessage = "خطا در ثبت سفارش";
      let details = {};

      // Extract error code if present (format: "ERROR_CODE: message")
      if (errorMessage.includes(":")) {
        const parts = errorMessage.split(":");
        errorCode = parts[0].trim();
        const errorDetail = parts.slice(1).join(":").trim();

        // Map error codes to user-friendly Persian messages
        switch (errorCode) {
          case "CART_EMPTY":
            userMessage = "سبد خرید شما خالی است";
            break;
          case "INVALID_ITEM":
            userMessage = "برخی از کالاهای سبد خرید معتبر نیستند";
            details = { detail: errorDetail };
            break;
          case "MISSING_PRODUCT_TITLE":
          case "MISSING_PRODUCT_SKU":
            userMessage = "اطلاعات برخی از کالاها ناقص است. لطفاً با پشتیبانی تماس بگیرید";
            details = { detail: errorDetail };
            break;
          case "INVALID_PRICE":
            userMessage = "قیمت برخی از کالاها نامعتبر است";
            details = { detail: errorDetail };
            break;
          case "ORDER_ITEM_CREATION_FAILED":
            userMessage = "خطا در ثبت اقلام سفارش";
            details = { detail: errorDetail };
            break;
          case "CONTRACT_CREATION_FAILED":
            userMessage = "خطا در ایجاد قرارداد";
            details = { detail: errorDetail };
            break;
          case "STOCK_RESERVATION_FAILED":
            userMessage =
              "موجودی برخی از کالاها تغییر کرده است. لطفاً سبد خرید را بروزرسانی کرده و دوباره تلاش کنید";
            details = { detail: errorDetail };
            break;
          case "INVALID_AMOUNT":
            userMessage = "مبلغ سفارش نامعتبر است";
            break;
          case "INVALID_TAX_PERCENT":
            userMessage = "درصد مالیات نامعتبر است";
            break;
          case "INVALID_RESERVATION":
            userMessage = "خطا در رزرو موجودی. لطفاً مجدداً تلاش کنید";
            break;
          case "RESERVE_WINDOW_CLOSED":
            userMessage =
              "مهلت افزودن به سفارش رزروی به پایان رسیده است. این سفارش را به صورت جداگانه ثبت کنید.";
            break;
          case "RESERVE_ALREADY_ACTIVE":
            userMessage = "شما یک سفارش رزروی فعال دارید";
            break;
          case "DISCOUNT_USAGE_EXHAUSTED":
            userMessage = "ظرفیت استفاده از این کد تخفیف تکمیل شده است";
            details = { detail: errorDetail };
            break;
          case "PAYMENT_IN_PROGRESS":
            userMessage =
              "پرداخت قبلی هنوز در حال بررسی است. لطفاً چند لحظه بعد وضعیت سفارش را بررسی کنید.";
            break;
          default:
            userMessage = "خطا در ثبت سفارش. لطفاً مجدداً تلاش کنید";
        }
      }

      // Every failed checkout is reported, not just the unmapped ones: a shopper
      // who cannot pay is the same loss whichever branch above produced the
      // banner. Severity separates the two kinds — a mapped code is a condition
      // we understand (stock moved, coupon exhausted), while an unmapped one is
      // infrastructure. A missing `orders.analytics_correlation_id` column
      // silently killed checkout for four weeks as the latter.
      const mapped = errorCode !== "UNKNOWN_ERROR";
      try {
        Sentry.captureException(error, {
          level: mapped ? "warning" : "error",
          tags: {
            area: "checkout",
            stage: "finalizeCartToOrder",
            errorCode,
            gateway: gateway || "none",
            mapped: String(mapped),
          },
          extra: redactSensitive({
            userId,
            cartId: cart?.id,
            itemCount: cart?.cart_items?.length || 0,
            gateway,
            errorMessage,
            shippingId: shippingData?.shippingId,
            hasDiscountCode: Boolean(shippingData?.discountCode),
            isReserveOrder: Boolean(shippingData?.reserveShipping || shippingData?.reserveOrderData),
          }),
        });
      } catch (reportError) {
        // Reporting must never turn the shopper's 400 into a 500.
        strapi.log.error("Failed to report checkout failure", reportError);
      }

      // Log to order-log if we have a userId for tracking
      try {
        await strapi.entityService.create("api::order-log.order-log", {
          data: {
            order: null,
            Action: "Create",
            Description: `Order creation failed: ${errorCode}`,
            Changes: {
              userId,
              errorCode,
              errorMessage,
              shippingId: shippingData?.shippingId,
              addressId: shippingData?.addressId,
            },
          },
        });
      } catch (logError) {
        // Swallow logging errors to avoid masking the original error
        strapi.log.error("Failed to log order creation failure", logError);
      }

      return {
        success: false,
        message: userMessage,
        error: errorMessage,
        errorCode,
        details,
        timestamp: new Date().toISOString(),
      };
    }
  },
}));
