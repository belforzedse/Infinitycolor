/**
 * cart service
 */

import * as Sentry from "@sentry/node";
import { factories } from "@strapi/strapi";
import { getOrCreateUserCart, type GetUserCartOptions } from "./lib/get-user-cart";
import { createOrderAndItems } from "./lib/order";
import { computeCouponDiscount, findFirstActiveGeneralDiscount } from "./lib/discounts";
import { claimLimitedDiscountUsage } from "./lib/discount-claim";
import { computeTotals } from "./lib/financials";
import { createContract } from "./lib/contract";
import { reserveStockAtomic, StockReservationError } from "./lib/stock";
import { routeExpectedDiagnostic } from "../../../utils/diagnostic-log";
import {
  lockReserveGroup,
  RESERVE_GROUP_STATES,
  ReserveWindowClosedError,
  UID as RESERVE_GROUP_UID,
} from "../../reserve-group/lib/reserve-group";
import { addCartItemOp } from "./ops/addCartItem";
import { updateCartItemOp } from "./ops/updateCartItem";
import { removeCartItemOp } from "./ops/removeCartItem";
import { checkCartStockOp, type CheckCartStockOptions } from "./ops/checkCartStock";
import { createCheckoutQuote, type CheckoutQuote } from "./lib/checkout-quote";
import {
  createPaymentAttempt,
  findPaymentAttempt,
  updatePaymentAttempt,
} from "../../payment-attempt/services/payment-attempt";
import {
  checkoutAttemptOrderId,
  gateCheckoutResume,
  RESERVATION_EXPIRED_RESULT,
  RESERVATION_LOOKUP_FAILED_RESULT,
} from "./lib/checkout-resume";
import {
  generateSnappayCallbackNonce,
  generateSnappayTransactionId,
  hashSnappayCallbackNonce,
} from "../../payment-gateway/services/snappay-security";
import { runRawSql } from "../../../utils/transactionExecutor";
import { redactSensitive } from "../../../utils/redactSensitive";
import { buildWalletCheckoutContext } from "./lib/wallet-checkout";
import {
  PaymentAllocationError,
  tomanToIrr,
  type PaymentAllocation,
} from "./lib/payment-allocation";
import {
  requestProviderHoldRelease,
  supersedeCheckoutAttempt,
} from "./lib/checkout-supersede";
import {
  holdWalletForAttempt,
  WalletHoldError,
} from "../../local-user-wallet/services/wallet-holds";
import { isWalletHoldsEnabled } from "../../local-user-wallet/services/wallet-readiness";

export default factories.createCoreService("api::cart.cart", ({ strapi }) => ({
  async getUserCart(userId: number, options?: GetUserCartOptions) {
    return getOrCreateUserCart(strapi as any, userId, options);
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

  async checkCartStock(userId: number, options?: CheckCartStockOptions) {
    return checkCartStockOp(strapi as any, userId, options);
  },

  async finalizeCartToOrder(userId: number, shippingData: any) {
    const gateway = String(shippingData?.gateway || "")
      .trim()
      .toLowerCase();
    const managesPaymentAttempt = gateway !== "";
    const attemptId = String(shippingData?.attemptId || "").trim();
    const expectedQuoteHash = String(shippingData?.quoteHash || "").trim();
    const requestedWalletAmount = shippingData?.walletAmountToman;
    const supersedeAttemptId = String(shippingData?.supersedeAttemptId || "").trim();
    /** A provider-bound predecessor whose hold we have just asked to have released. */
    let walletReleaseRequested = false;

    if (managesPaymentAttempt) {
      if (!attemptId || attemptId.length > 128) {
        return {
          success: false,
          status: 400,
          errorCode: "CHECKOUT_ATTEMPT_REQUIRED",
          message: "Checkout attempt id is required",
        };
      }

      const replay = await findPaymentAttempt(strapi as any, userId, attemptId);
      if (replay) {
        const decision = await gateCheckoutResume(
          strapi as any,
          userId,
          { ...replay, attemptId },
          gateway,
          expectedQuoteHash,
        );
        if (decision === "in_progress") {
          const orderId = checkoutAttemptOrderId(replay);
          return {
            success: false,
            status: 409,
            errorCode: "PAYMENT_IN_PROGRESS",
            message:
              "پرداخت قبلی هنوز در حال بررسی است. لطفاً چند لحظه بعد وضعیت سفارش را بررسی کنید.",
            ...(orderId ? { orderId } : {}),
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
        if (decision === "expired") {
          return { ...RESERVATION_EXPIRED_RESULT };
        }
        if (decision === "unavailable") {
          return { ...RESERVATION_LOOKUP_FAILED_RESULT };
        }
        if (decision !== "incomplete") {
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

      if (!expectedQuoteHash) {
        return {
          success: false,
          status: 400,
          errorCode: "CHECKOUT_QUOTE_REQUIRED",
          message: "Checkout quote is required",
        };
      }

      // The customer replaced an earlier checkout of their own (they changed the
      // wallet amount, or the totals moved). Release exactly that one — never
      // every `Created` attempt they have — so its wallet credit and stock come
      // back before this attempt tries to reserve them. A predecessor that has
      // already been handed to a provider is refused and keeps its funds.
      if (supersedeAttemptId) {
        const superseded = await supersedeCheckoutAttempt(strapi as any, {
          userId,
          attemptId: supersedeAttemptId,
          replacementAttemptId: attemptId,
        });
        if (superseded.outcome === "superseded") {
          strapi.log.info(
            `Checkout attempt ${supersedeAttemptId} superseded by ${attemptId} for user ${userId}; released ${superseded.releasedIrr} IRR`,
          );
        } else {
          strapi.log.info(
            `Checkout attempt ${supersedeAttemptId} was not superseded by ${attemptId}: ${superseded.reason}`,
          );
          if (superseded.reason === "provider_bound") {
            // A SnappPay predecessor: its hold can never be released inline,
            // but the shopper naming it while re-checking-out *is* them saying
            // they did not complete that payment. Ask the queue to resolve it
            // against the provider; the release lands a few seconds later, and
            // the refusal below tells them to try again rather than leaving
            // their credit pinned until the reservation defer ceiling.
            walletReleaseRequested = await requestProviderHoldRelease(
              strapi as any,
              userId,
              supersedeAttemptId,
            );
          }
        }
      }
    }

    // New purchases do not credit another attempt's reservation. Available
    // stock is Count minus reserved_count; shortfalls still remove/reduce.
    const stockCheck = await this.checkCartStock(userId);

    if (stockCheck.errorCode === "RESERVATION_LOOKUP_FAILED") {
      return { ...RESERVATION_LOOKUP_FAILED_RESULT };
    }

    if (!stockCheck.valid) {
      // Returned without an errorCode and with an English message, so the
      // storefront cannot map it and falls back to the generic banner. Reported
      // here because it never reaches the catch block below, which means it is
      // otherwise invisible in both Sentry and the order-log table.
      try {
        if (!routeExpectedDiagnostic("checkout.stock_changed_before_payment", {
          area: "checkout", stage: "stockCheck", reasonCode: "STOCK_CHANGED", gateway: gateway || "none",
          removedCount: stockCheck.itemsRemoved?.length || 0, adjustedCount: stockCheck.itemsAdjusted?.length || 0,
        })) Sentry.captureMessage("checkout.stock_changed_before_payment", {
          level: "warning",
          tags: {
            area: "checkout",
            stage: "stockCheck",
            errorCode: "STOCK_CHANGED",
            gateway: gateway || "none",
          },
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
      return {
        success: false,
        errorCode: "CART_EMPTY",
        message: "Cannot create order from empty cart",
      };
    }

    let checkoutQuote: CheckoutQuote | null = null;
    let paymentAllocation: PaymentAllocation | null = null;
    if (managesPaymentAttempt) {
      // The wallet context is rebuilt with no reusable credit: by this point the
      // named predecessor has either been superseded (its hold released, so the
      // money is plainly available) or it has not, in which case that money is
      // genuinely unavailable and the allocation must say so.
      const walletContext = await buildWalletCheckoutContext(strapi as any, userId, {
        selectedGateway: gateway,
        requestedWalletAmount,
      });
      try {
        checkoutQuote = await createCheckoutQuote(strapi as any, userId, {
          cart,
          shippingId: shippingData.shippingId,
          shippingCost: shippingData.shippingCost,
          discountCode: shippingData.discountCode,
          gateway,
          reserveGroupId: shippingData.reserveGroupId,
          resolveAllocation: walletContext.resolve,
        });
      } catch (allocationError: any) {
        if (!(allocationError instanceof PaymentAllocationError)) throw allocationError;
        // The credit this checkout wants is the credit we just asked the
        // provider to let go of. Say so, so the storefront offers "try again in
        // a moment" instead of "check that other payment" for a payment the
        // shopper has already told us they abandoned.
        const releasePending =
          walletReleaseRequested &&
          allocationError.code === "WALLET_FUNDS_HELD_BY_PENDING_PAYMENT";
        return {
          success: false,
          status: 409,
          errorCode: releasePending
            ? "WALLET_HOLD_RELEASE_IN_PROGRESS"
            : allocationError.code,
          message: releasePending
            ? "در حال آزادسازی اعتبار کیف پول از پرداخت قبلی شماست. چند لحظه دیگر دوباره تلاش کنید."
            : allocationError.message,
          paymentCapabilities: walletContext.capabilities,
          details: allocationError.details,
        };
      }
      paymentAllocation = checkoutQuote.paymentAllocation ?? null;
      if (checkoutQuote.quoteHash !== expectedQuoteHash) {
        return {
          success: false,
          status: 409,
          errorCode: "CHECKOUT_QUOTE_CHANGED",
          message: "قیمت یا موجودی سبد خرید تغییر کرده است",
          quote: checkoutQuote,
          paymentCapabilities: walletContext.capabilities,
        };
      }
      // Wallet credit covering the whole total changes which gateway must be
      // used. The gateway is part of the hash, so the server asks the client to
      // re-quote as wallet-only rather than silently redirecting the payment.
      if (paymentAllocation && paymentAllocation.requiredGateway !== gateway) {
        return {
          success: false,
          status: 409,
          errorCode: "WALLET_COVERS_TOTAL",
          message: "موجودی کیف پول کل مبلغ سفارش را پوشش می‌دهد. پرداخت با کیف پول را انتخاب کنید.",
          quote: checkoutQuote,
          paymentCapabilities: walletContext.capabilities,
        };
      }
      if (gateway === "snappay") {
        await strapi
          .service("api::payment-gateway.snappay-orchestrator")
          .checkEligibility(
            tomanToIrr(paymentAllocation?.gatewayToman ?? checkoutQuote.financialSummary.total),
          );
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
            const decision = await gateCheckoutResume(
              strapi as any,
              userId,
              { ...replay, attemptId },
              gateway,
              expectedQuoteHash,
            );
            if (decision === "in_progress") {
              throw new Error("PAYMENT_IN_PROGRESS: Unresolved SnappPay payment is still live");
            }
            if (decision === "conflict") {
              throw new Error(
                "CHECKOUT_ATTEMPT_CONFLICT: Attempt id was already used for another quote",
              );
            }
            if (decision === "expired") {
              throw new Error("RESERVATION_EXPIRED: Reservation is no longer held");
            }
            if (decision === "unavailable") {
              throw new Error("RESERVATION_LOOKUP_FAILED: Reservation could not be read");
            }
            if (decision !== "incomplete") {
              return {
                success: true,
                replayed: true,
                order: replay.order,
                contract: replay.contract,
                paymentAttempt: replay,
                financialSummary: replay.quoteSnapshot?.financialSummary,
              };
            }
            const orphanId = Number(replay.id);
            if (Number.isInteger(orphanId) && orphanId > 0) {
              await runRawSql(
                strapi as any,
                `SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE`,
                [orphanId],
                trx,
              );
              const locked = await findPaymentAttempt(strapi as any, userId, attemptId, trx);
              if (locked && checkoutAttemptOrderId(locked)) {
                return {
                  success: true,
                  replayed: true,
                  order: locked.order,
                  contract: locked.contract,
                  paymentAttempt: locked,
                  financialSummary: locked.quoteSnapshot?.financialSummary,
                };
              }
            }
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
            throw new StockReservationError(reserveRes.reason, reserveRes.error || "reserve_failed");
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

        // `Amount` stays the order total: payment-status, SnappPay resume checks
        // and admin update all read it. The two legs are recorded alongside it
        // and are immutable funding facts once written.
        const walletLegToman = paymentAllocation?.walletToman ?? 0;
        const gatewayLegToman = paymentAllocation ? paymentAllocation.gatewayToman : totals.total;
        const holdsEnabled = isWalletHoldsEnabled();
        const attemptFields = {
          quoteHash: expectedQuoteHash,
          quoteSnapshot: checkoutQuote,
          Status: "Created" as const,
          Gateway: gateway,
          Amount: tomanToIrr(Math.round(totals.total)),
          WalletAmount: tomanToIrr(walletLegToman),
          GatewayAmount: tomanToIrr(gatewayLegToman),
          // Written on every new-format attempt so settlement never has to guess:
          // `None` is "no wallet leg", `DirectDebit` is "wallet leg, but holds
          // were switched off when this was created", and NULL only ever means
          // a row written before this feature shipped.
          WalletHoldStatus:
            walletLegToman === 0
              ? ("None" as const)
              : holdsEnabled
                ? ("None" as const)
                : ("DirectDebit" as const),
          ...(supersedeAttemptId ? { SupersedesAttemptId: supersedeAttemptId } : {}),
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
        };
        let paymentAttempt: Awaited<ReturnType<typeof createPaymentAttempt>> | undefined;
        if (managesPaymentAttempt) {
          const existingAttempt = await findPaymentAttempt(strapi as any, userId, attemptId, trx);
          if (existingAttempt && !checkoutAttemptOrderId(existingAttempt)) {
            paymentAttempt = await updatePaymentAttempt(
              strapi as any,
              Number(existingAttempt.id),
              attemptFields,
              trx,
            );
          } else {
            paymentAttempt = await createPaymentAttempt(
              strapi as any,
              { attemptId, ...attemptFields },
              trx,
            );
          }
        }

        // Wallet hold, last in the lock order (orders -> payment_attempts ->
        // product_stocks -> wallet). It commits with the order, its items, the
        // stock reservation and the coupon claim, or none of them happen.
        if (managesPaymentAttempt && paymentAttempt && walletLegToman > 0 && holdsEnabled) {
          await runRawSql(
            strapi as any,
            "SELECT id FROM payment_attempts WHERE id = ? FOR UPDATE",
            [Number(paymentAttempt.id)],
            trx,
          );
          await holdWalletForAttempt(
            strapi as any,
            {
              userId,
              paymentAttemptId: Number(paymentAttempt.id),
              amountIrr: tomanToIrr(walletLegToman),
            },
            trx,
          );
        }

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
              // SnappPay finances only its own leg. Any wallet contribution is
              // persisted separately when the hold is captured.
              Amount: Math.round(gatewayLegToman * 10),
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
              SettlementGateway: "SnappPay",
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
          ...(paymentAllocation ? { paymentAllocation } : {}),
        };
      });

      return result;
    } catch (error: any) {
      if (managesPaymentAttempt) {
        const replay = await findPaymentAttempt(strapi as any, userId, attemptId).catch(() => null);
        if (
          replay &&
          (await gateCheckoutResume(
            strapi as any,
            userId,
            { ...replay, attemptId },
            gateway,
            expectedQuoteHash,
          )) === "replay"
        ) {
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

      // A wallet hold that could not be taken is a business conflict, not an
      // internal failure: the whole transaction has rolled back, so no order,
      // reservation, coupon claim or held credit survives. The customer is told
      // exactly which condition failed and is given the fresh figures.
      if (error instanceof WalletHoldError || error instanceof PaymentAllocationError) {
        strapi.log.info(
          `Checkout ${attemptId} for user ${userId} refused by the wallet: ${error.code}`,
        );
        return {
          success: false,
          status: 409,
          errorCode: error.code,
          message:
            error instanceof PaymentAllocationError
              ? error.message
              : "موجودی قابل استفاده کیف پول کافی نیست. مبلغ را تغییر دهید.",
          details: error instanceof PaymentAllocationError ? error.details : error.details,
        };
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
            if (error instanceof StockReservationError && error.reason === "insufficient_stock") {
              userMessage = "موجودی برخی از کالاها تغییر کرده است. لطفاً سبد خرید را بروزرسانی کرده و دوباره تلاش کنید";
              details = { reason: "insufficient_stock" };
            } else {
              userMessage = "خطا در ثبت سفارش. لطفاً مجدداً تلاش کنید";
              details = {};
            }
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
          case "RESERVATION_EXPIRED":
            userMessage = RESERVATION_EXPIRED_RESULT.message;
            break;
          case "RESERVATION_LOOKUP_FAILED":
            userMessage = RESERVATION_LOOKUP_FAILED_RESULT.message;
            break;
          case "CHECKOUT_ATTEMPT_CONFLICT":
            userMessage = "شناسه پرداخت قبلاً برای پیش‌فاکتور دیگری استفاده شده است";
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
      let telemetryOwner: "backend" | undefined;
      try {
        const expected = error instanceof StockReservationError && error.reason === "insufficient_stock";
        const routed = expected && routeExpectedDiagnostic("checkout.failure", {
          area: "checkout", stage: "finalizeCartToOrder", reasonCode: "insufficient_stock", gateway: gateway || "none",
        });
        if (routed) telemetryOwner = "backend";
        else if (Sentry.captureException(error, {
          level: mapped && (errorCode !== "STOCK_RESERVATION_FAILED" || expected) ? "warning" : "error",
          tags: {
            area: "checkout",
            stage: "finalizeCartToOrder",
            errorCode,
            gateway: gateway || "none",
            mapped: String(mapped),
            ...(error instanceof StockReservationError ? { stock_failure_reason: error.reason || "unknown" } : {}),
          },
          extra: redactSensitive({
            userId,
            cartId: cart?.id,
            itemCount: cart?.cart_items?.length || 0,
            gateway,
            errorMessage,
            shippingId: shippingData?.shippingId,
            hasDiscountCode: Boolean(shippingData?.discountCode),
            isReserveOrder: Boolean(
              shippingData?.reserveShipping || shippingData?.reserveOrderData,
            ),
          }),
        }) && Sentry.isEnabled()) telemetryOwner = "backend";
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
        ...(telemetryOwner ? { telemetryOwner } : {}),
        timestamp: new Date().toISOString(),
        ...(errorCode === "RESERVATION_LOOKUP_FAILED"
          ? { status: 503 }
          : errorCode === "RESERVATION_EXPIRED" ||
              errorCode === "PAYMENT_IN_PROGRESS" ||
              errorCode === "CHECKOUT_ATTEMPT_CONFLICT"
            ? { status: 409 }
            : {}),
      };
    }
  },
}));
