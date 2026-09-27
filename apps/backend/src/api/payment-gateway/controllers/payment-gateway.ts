// @ts-nocheck
/**
 * payment-gateway controller
 */

import { factories } from "@strapi/strapi";
import { computeCouponDiscount } from "../../cart/services/lib/discounts";
import { Strapi } from "@strapi/strapi";
import { getAvailableCheckoutGateways } from "../services/checkout-gateway-availability";
import { resolveCustomerTargetUserId } from "../../../utils/roles";
import {
  assertSnappayRuntimeConfig,
  isSnappayHardenedInitiationEnabled,
} from "../services/snappay-orchestrator";
import { buildPaymentCapabilities } from "../../cart/services/lib/payment-allocation";
import { chargeableVariationPrice } from "../../../utils/productAvailability";
import {
  isWalletSnappaySplitEnabled,
  isWalletSplitEnabled,
} from "../../local-user-wallet/services/wallet-readiness";

export default factories.createCoreController(
  "api::payment-gateway.payment-gateway",
  ({ strapi }: { strapi: Strapi }) => ({
    async availableGateways(ctx) {
      try {
        const gateways = await getAvailableCheckoutGateways(strapi);
        // Reported alongside the gateways so the storefront renders what the
        // server will actually accept, instead of inferring a feature flag from
        // a field that happens to be missing from a later response.
        const paymentCapabilities = buildPaymentCapabilities({
          walletGatewayAvailable: gateways.some((gateway) => gateway.code === "wallet"),
          splitEnabled: isWalletSplitEnabled(),
          snappaySplitEnabled: isWalletSnappaySplitEnabled(),
        });
        return ctx.send({ data: { gateways, paymentCapabilities } });
      } catch (error) {
        strapi.log.error("Failed to resolve available checkout gateways", {
          message: (error as Error)?.message || String(error),
          stack: (error as Error)?.stack,
        });
        return ctx.badRequest("Failed to resolve available checkout gateways", {
          data: { success: false, error: (error as Error)?.message || String(error) },
        });
      }
    },

    // Test endpoint for debugging Mellat gateway
    async testMellat(ctx) {
      try {
        const {
          amount = 10000,
          orderId = Math.floor(Math.random() * 1000000),
        } = ctx.request.body;

        strapi.log.info("Testing Mellat gateway with parameters:", {
          amount,
          orderId,
        });

        // Get the Mellat service
        const paymentService = strapi.service("api::payment-gateway.mellat");

        // Test payment request
        const result = await paymentService.requestPayment({
          orderId: orderId,
          amount: amount,
          userId: 1, // Test user ID
          callbackURL: "/test/callback",
          contractId: 0,
        });

        strapi.log.info("Mellat test result:", result);

        return ctx.send({
          data: {
            success: result.success,
            message: result.success
              ? "Mellat gateway test successful"
              : "Mellat gateway test failed",
            result: result,
            testParameters: { amount, orderId },
            timestamp: new Date().toISOString(),
          },
        });
      } catch (error) {
        strapi.log.error("Error testing Mellat gateway:", {
          message: error.message,
          stack: error.stack,
        });

        return ctx.badRequest("Test failed", {
          data: {
            success: false,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString(),
          },
        });
      }
    },

    // Compute SnappPay eligibility based on current cart and shipping
    async snappEligible(ctx) {
      try {
        if (!isSnappayHardenedInitiationEnabled()) {
          return ctx.send({
            data: {
              eligible: false,
              message: "SnappPay checkout is temporarily unavailable",
            },
          });
        }
        assertSnappayRuntimeConfig();
        const userId = await resolveCustomerTargetUserId(ctx, strapi);
        if (!userId) return;

        // Params
        // IMPORTANT: amount parameter should be the final قابل پرداخت (payable amount in Toman)
        const amountTomanParam = ctx.request.query?.amount
          ? Number(ctx.request.query.amount)
          : undefined;

        const shippingId = ctx.request.query?.shippingId
          ? Number(ctx.request.query.shippingId)
          : undefined;
        const shippingCostParam = ctx.request.query?.shippingCost
          ? Number(ctx.request.query.shippingCost)
          : undefined;
        const discountCodeParam =
          (ctx.request.query?.discountCode as string | undefined) ||
          (ctx.request.body?.discountCode as string | undefined);

        // If amount is provided directly from frontend (قابل پرداخت), use it —
        // but only after bounding it against the caller's real cart.
        //
        // The storefront computes the payable total client-side (it holds the
        // selected shipping and any discount preview), so the server cannot
        // reproduce it from the cart alone and has to accept the value. Taking it
        // unconditionally, however, turned this endpoint into an unmetered
        // eligibility oracle: any authenticated user could loop arbitrary amounts
        // and each call became an authenticated outbound request against our
        // production SnappPay credentials. Requiring a non-empty cart and
        // rejecting amounts the cart could not plausibly produce keeps the value
        // tied to a real checkout without breaking the legitimate flow.
        if (amountTomanParam !== undefined) {
          if (!Number.isFinite(amountTomanParam) || amountTomanParam <= 0) {
            return ctx.send({
              data: { eligible: false, message: "Invalid amount" },
            });
          }

          const cartService = strapi.service("api::cart.cart");
          const cart = await cartService.getUserCart(userId);
          if (!cart?.cart_items?.length) {
            return ctx.send({
              data: { eligible: false, message: "Cart is empty" },
            });
          }

          let cartSubtotal = 0;
          for (const item of cart.cart_items) {
            const price = chargeableVariationPrice(item?.product_variation);
            cartSubtotal += price * Number(item?.Count || 0);
          }

          // A discount can only lower the payable total, shipping can only raise
          // it, so the cart subtotal plus the priciest shipping method is a hard
          // upper bound on any legitimate payable amount.
          const shippingMethods = await strapi.entityService.findMany(
            "api::shipping.shipping",
            { fields: ["Price"] } as any,
          );
          const maxShipping = (shippingMethods || []).reduce(
            (max: number, method: any) => Math.max(max, Number(method?.Price || 0)),
            0,
          );
          const upperBound = Math.round(cartSubtotal) + Math.round(maxShipping);

          if (amountTomanParam > upperBound) {
            strapi.log.warn("Rejected SnappPay eligibility amount above cart bound", {
              userId,
              amountToman: amountTomanParam,
              upperBound,
            });
            return ctx.send({
              data: { eligible: false, message: "Amount does not match the cart" },
            });
          }

          const amountIRR = Math.max(0, amountTomanParam) * 10;

          strapi.log.info("SnappPay eligible request (direct amount)", {
            userId,
            amountToman: amountTomanParam,
            amountIRR,
          });

          const snappay = strapi.service("api::payment-gateway.snappay");
          const eligibleResp = await snappay.eligible(amountIRR);
          strapi.log.info("SnappPay eligible result", {
            successful: eligibleResp?.successful,
            eligible: eligibleResp?.response?.eligible,
            error: eligibleResp?.errorData,
          });

          const payload = {
            eligible: !!eligibleResp?.response?.eligible,
            title: eligibleResp?.response?.title_message,
            description: eligibleResp?.response?.description,
            amountIRR,
          };

          return ctx.send({ data: payload });
        }

        // Load user's current cart with items (same as applyDiscount)
        const cartService = strapi.service("api::cart.cart");
        const cart = await cartService.getUserCart(userId);

        if (!cart?.cart_items?.length) {
          return ctx.send({
            data: { eligible: false, message: "Cart is empty" },
          });
        }

        // Compute subtotal from cart (same logic as applyDiscount)
        let subtotal = 0;
        for (const item of cart.cart_items) {
          const price = chargeableVariationPrice(item?.product_variation);
          const count = Number(item?.Count || 0);
          subtotal += price * count;

        }

        // Discounts: apply coupon first if provided, otherwise fallback to general discount
        let discountAmount = 0;
        if (discountCodeParam) {
          try {
            discountAmount = await computeCouponDiscount(
              strapi as any,
              userId,
              String(discountCodeParam),
              subtotal,
              cart.cart_items,
              shippingId
            );
          } catch (e) {
            strapi.log.error("Failed to compute coupon discount for eligibility", e);
          }
        }
        if (!discountAmount) {
          const generalDiscounts = await strapi.entityService.findMany(
            "api::general-discount.general-discount",
            {
              filters: {
                IsActive: true,
                StartDate: { $lte: new Date() },
                EndDate: { $gte: new Date() },
              },
              sort: { createdAt: "desc" },
            },
          );
          for (const discount of generalDiscounts || []) {
            const d = discount as any;
            if (d.MinimumAmount <= subtotal) {
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

        // Shipping (toman)
        let shippingCost = shippingCostParam || 0;
        if (!shippingCost && shippingId) {
          const shipping = await strapi.entityService.findOne("api::shipping.shipping", shippingId);
          if (shipping?.Price) shippingCost = Number(shipping.Price);
        }

        // Total (toman) → convert to IRR (tax disabled)
        const totalToman =
          Math.round(subtotal) - Math.round(discountAmount) + Math.round(shippingCost);
        const amountIRR = Math.max(0, totalToman) * 10;

        // Call Snapp eligibility
        const snappay = strapi.service("api::payment-gateway.snappay");
        strapi.log.info("SnappPay eligible request", {
          userId,
          amountIRR,
          hasDiscountCode: !!discountCodeParam,
          discountToman: Math.round(discountAmount),
          debugAmounts: {
            subtotalToman: Math.round(subtotal),
            discountToman: Math.round(discountAmount),
            shippingToman: Math.round(shippingCost),
            totalToman,
            totalIRR: amountIRR,
          },
        });
        const eligibleResp = await snappay.eligible(amountIRR);
        strapi.log.info("SnappPay eligible result", {
          successful: eligibleResp?.successful,
          eligible: eligibleResp?.response?.eligible,
          error: eligibleResp?.errorData,
        });

        const payload = {
          eligible: !!eligibleResp?.response?.eligible,
          title: eligibleResp?.response?.title_message,
          description: eligibleResp?.response?.description,
          amountIRR,
        };

        return ctx.send({ data: payload });
      } catch (error) {
        strapi.log.error("SnappPay eligibility error:", {
          message: error.message,
          stack: error.stack,
        });
        return ctx.badRequest("Eligibility failed", {
          data: { success: false, error: error.message },
        });
      }
    },

    // Test endpoint for the new Mellat V2 implementation
    async testMellatV2(ctx) {
      try {
        const {
          amount = 10000,
          orderId = Math.floor(Math.random() * 1000000),
        } = ctx.request.body;

        strapi.log.info("Testing Mellat V2 gateway with parameters:", {
          amount,
          orderId,
        });

        // Get the Mellat V2 service
        const paymentService = strapi.service("api::payment-gateway.mellat-v2");

        // Test payment request
        const result = await paymentService.requestPayment({
          orderId: orderId,
          amount: amount,
          userId: 1, // Test user ID
          callbackURL: "/test/callback",
          contractId: 0,
        });

        strapi.log.info("Mellat V2 test result:", result);

        return ctx.send({
          data: {
            success: result.success,
            message: result.success
              ? "Mellat V2 gateway test successful"
              : "Mellat V2 gateway test failed",
            result: result,
            testParameters: { amount, orderId },
            timestamp: new Date().toISOString(),
            version: "v2",
          },
        });
      } catch (error) {
        strapi.log.error("Error testing Mellat V2 gateway:", {
          message: error.message,
          stack: error.stack,
        });

        return ctx.badRequest("Test failed", {
          data: {
            success: false,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString(),
            version: "v2",
          },
        });
      }
    },

    // Test endpoint for the new Mellat V3 implementation using mellat-checkout package
    async testMellatV3(ctx) {
      try {
        const {
          amount = 10000,
          orderId = Math.floor(Math.random() * 1000000),
        } = ctx.request.body;

        strapi.log.info("Testing Mellat V3 gateway with parameters:", {
          amount,
          orderId,
        });

        // Get the Mellat V3 service
        const paymentService = strapi.service("api::payment-gateway.mellat-v3");

        // Test payment request
        const result = await paymentService.requestPayment({
          orderId: orderId,
          amount: amount,
          userId: 1, // Test user ID
          callbackURL: "/test/callback",
          contractId: 0,
        });

        strapi.log.info("Mellat V3 test result:", result);

        return ctx.send({
          data: {
            success: result.success,
            message: result.success
              ? "Mellat V3 gateway test successful"
              : "Mellat V3 gateway test failed",
            result: result,
            testParameters: { amount, orderId },
            timestamp: new Date().toISOString(),
            version: "v3",
            package: "mellat-checkout",
          },
        });
      } catch (error) {
        strapi.log.error("Error testing Mellat V3 gateway:", {
          message: error.message,
          stack: error.stack,
        });

        return ctx.badRequest("Test failed", {
          data: {
            success: false,
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString(),
            version: "v3",
            package: "mellat-checkout",
          },
        });
      }
    },
  })
);
