// @ts-nocheck
/**
 * wallet-topup controller
 */

import { factories } from "@strapi/strapi";
import type { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../utils/roles";
import {
  applyConfirmedWalletTopup,
  claimWalletTopupCallback,
  findWalletTopupCredit,
  markWalletTopupFailed,
  markWalletTopupUnknown,
} from "../services/wallet-topup";

const FRONTEND_BASE =
  process.env.FRONTEND_URL || "https://infinitycolor.co";

const WALLET_TOPUP_UID = "api::wallet-topup.wallet-topup";

/**
 * Decides whether a callback may drive a destructive transition on this top-up.
 *
 * `SaleOrderId` is caller-supplied and only locates a candidate row. Mellat mints `RefId`
 * at bpPayRequest time and echoes it back in the browser callback, and chargeIntent
 * persists it, so it is the one field that ties a callback to this specific attempt — the
 * same anchor the order flow uses via payment_attempts.providerReference.
 *
 * When no RefId was persisted (the write is best-effort at initiation) the callback
 * cannot be correlated at all. That is deliberately not treated as permission to mutate:
 * the row stays Pending for reconciliation instead.
 */
function isCallbackCorrelated(topup: any, callbackRefId: string): boolean {
  const persistedRefId = String(topup?.RefId ?? "").trim();
  if (!persistedRefId) return false;
  return persistedRefId === callbackRefId;
}

function isUniqueConstraintError(error: any) {
  return (
    error?.code === "23505" ||
    /unique|duplicate/i.test(String(error?.message || "")) ||
    /unique|duplicate/i.test(String(error?.details || ""))
  );
}

let lastSaleOrderTimestamp = 0;

function generateWalletSaleOrderId(): string {
  const now = Date.now();
  lastSaleOrderTimestamp =
    now <= lastSaleOrderTimestamp ? lastSaleOrderTimestamp + 1 : now;
  const randomSuffix = Math.floor(Math.random() * 900) + 100; // 3 digits
  return `${lastSaleOrderTimestamp}${randomSuffix}`;
}

export default factories.createCoreController(
  "api::wallet-topup.wallet-topup",
  ({ strapi }: { strapi: Strapi }) => ({
    async chargeIntent(ctx) {
      try {
        const pluginUserId = await resolveCustomerTargetUserId(ctx, strapi);
        if (!pluginUserId) return;

        const { amount } = ctx.request.body || {};
        const amountIrr = Number(amount);
        if (!amountIrr || amountIrr <= 0) return ctx.badRequest("amount is required (IRR)");

        const saleOrderId = generateWalletSaleOrderId();

        const topup = await strapi.entityService.create("api::wallet-topup.wallet-topup", {
          data: {
            Amount: Math.round(amountIrr),
            Status: "Pending",
            SaleOrderId: saleOrderId,
            user: pluginUserId,
            Date: new Date(),
          },
        });

        const paymentService = strapi.service("api::payment-gateway.mellat-v3");
        if (!paymentService) {
          return ctx.badRequest("Payment service unavailable", {
            data: { success: false, error: "mellat service missing" },
          });
        }

        const configuredBase = String(
          strapi.config.get("server.url", process.env.URL || "https://api.infinitycolor.co/"),
        );
        let baseUrl = configuredBase.trim();
        if (!/^https?:\/\//i.test(baseUrl)) {
          baseUrl = process.env.URL || "https://api.infinitycolor.co/";
        }
        baseUrl = baseUrl.replace(/\/$/, "").replace(/\/api$/i, "");
        const callbackURL = `${baseUrl}/api/wallet/payment-callback`;

        const response = await paymentService.requestPayment({
          orderId: Number(saleOrderId),
          amount: Math.round(amountIrr),
          userId: pluginUserId,
          callbackURL,
          contractId: undefined,
          amountInRial: true, // Amount is already in IRR
        });

        if (!response?.success) {
          await strapi.entityService.update("api::wallet-topup.wallet-topup", topup.id, {
            data: { Status: "Failed" },
          });
          return ctx.badRequest("Gateway error", {
            data: { success: false, error: response?.error },
          });
        }

        try {
          await strapi.entityService.update("api::wallet-topup.wallet-topup", topup.id, {
            data: { RefId: response.refId },
          });
        } catch (e) {
          strapi.log.error("Failed to persist wallet topup token", {
            topupId: topup.id,
            saleOrderId,
            error: (e as any)?.message || String(e),
          });
        }

        return ctx.send({
          data: {
            success: true,
            redirectUrl: response.redirectUrl,
            refId: response.refId,
            saleOrderId,
          },
        });
      } catch (error) {
        return ctx.badRequest((error as any).message, {
          data: { success: false, error: (error as any).message },
        });
      }
    },

    async paymentCallback(ctx) {
      const { ResCode, SaleOrderId, SaleReferenceId, RefId } = (ctx.request as any).body || {};
      const saleOrderId = String(SaleOrderId ?? "").trim();
      const saleReferenceId = String(SaleReferenceId ?? "").trim();
      const callbackRefId = String(RefId ?? "").trim();

      try {
        if (!saleOrderId) {
          return ctx.redirect(
            `${FRONTEND_BASE}/wallet?status=failure&reason=invalid_callback`
          );
        }

        const topups = (await strapi.entityService.findMany(
          WALLET_TOPUP_UID,
          { filters: { SaleOrderId: saleOrderId }, limit: 1, populate: { user: true } }
        )) as any[];
        const topup = topups?.[0];

        if (!topup) {
          return ctx.redirect(
            `${FRONTEND_BASE}/wallet?status=failure&reason=not_found`
          );
        }

        const paymentService = strapi.service("api::payment-gateway.mellat-v3");

        const correlated = isCallbackCorrelated(topup, callbackRefId);

        const resCode = String(ResCode ?? "").trim();
        if (resCode !== "0") {
          // A failure callback destroys local state, so it must be correlated first.
          // Locating a row by the caller-supplied SaleOrderId is not authorization:
          // without this check anyone could POST a failure for a guessed SaleOrderId and
          // flip another customer's (possibly already successful) top-up to Failed.
          if (!correlated) {
            strapi.log.error(
              "Wallet topup failure callback could not be correlated; leaving attempt untouched",
              {
                topupId: topup.id,
                saleOrderId,
                hasPersistedRefId: Boolean(String(topup.RefId ?? "").trim()),
                callbackRefIdPresent: Boolean(callbackRefId),
              }
            );
            return ctx.redirect(
              `${FRONTEND_BASE}/wallet?status=failure&reason=unverified`
            );
          }

          await markWalletTopupFailed(strapi, {
            topupId: Number(topup.id),
            providerCode: Number.isFinite(Number(resCode)) ? Number(resCode) : null,
            error: `Mellat callback failure ${resCode}`,
          });
          return ctx.redirect(
            `${FRONTEND_BASE}/wallet?status=failure&code=${encodeURIComponent(resCode)}`
          );
        }

        // A mismatched RefId on a success callback points at a different attempt than the
        // one the SaleOrderId resolved to. Nothing is mutated: the bank verify below is
        // keyed on this row's saleOrderId, so proceeding could only settle the wrong one.
        if (String(topup.RefId ?? "").trim() && !correlated) {
          strapi.log.error("Wallet topup success callback RefId does not match the attempt", {
            topupId: topup.id,
            saleOrderId,
          });
          return ctx.redirect(`${FRONTEND_BASE}/wallet?status=failure&reason=unverified`);
        }

        if (!saleReferenceId) {
          return ctx.redirect(
            `${FRONTEND_BASE}/wallet?status=failure&reason=invalid_callback`
          );
        }

        if (await findWalletTopupCredit(strapi, saleReferenceId)) {
          return ctx.redirect(`${FRONTEND_BASE}/wallet?status=success`);
        }

        const claimed = await claimWalletTopupCallback(
          strapi,
          Number(topup.id),
          saleReferenceId,
        );
        if (!claimed) {
          const current: any = await strapi.db.query(WALLET_TOPUP_UID).findOne({
            where: { id: Number(topup.id) },
            select: ["Status"],
          } as any);
          if (
            current?.Status === "Success" ||
            (await findWalletTopupCredit(strapi, saleReferenceId))
          ) {
            return ctx.redirect(`${FRONTEND_BASE}/wallet?status=success`);
          }
          if (["Processing", "Unknown"].includes(String(current?.Status))) {
            return ctx.redirect(`${FRONTEND_BASE}/wallet?status=pending`);
          }
          return ctx.redirect(`${FRONTEND_BASE}/wallet?status=failure&reason=unverified`);
        }

        if (!paymentService) throw new Error("MELLAT_PAYMENT_SERVICE_UNAVAILABLE");
        const verifyResult = await paymentService.verifyTransaction({
          orderId: saleOrderId,
          saleOrderId,
          saleReferenceId,
        });
        const verifyCode = Number.isFinite(Number(verifyResult?.resCode))
          ? Number(verifyResult.resCode)
          : null;
        if (!verifyResult?.success && verifyCode !== 43) {
          await markWalletTopupUnknown(strapi, {
            topupId: Number(topup.id),
            providerCode: verifyCode,
            error: verifyResult?.error || "Mellat verification remains ambiguous",
          });
          return ctx.redirect(`${FRONTEND_BASE}/wallet?status=pending`);
        }

        const settleResult = await paymentService.settleTransaction({
          orderId: saleOrderId,
          saleOrderId,
          saleReferenceId,
          allowResCode45Success: true,
        });
        const settleCode = Number.isFinite(Number(settleResult?.resCode))
          ? Number(settleResult.resCode)
          : null;
        if (!settleResult?.success && settleCode !== 0 && settleCode !== 45) {
          await markWalletTopupUnknown(strapi, {
            topupId: Number(topup.id),
            providerCode: settleCode,
            error: settleResult?.error || "Mellat settlement remains ambiguous",
          });
          return ctx.redirect(`${FRONTEND_BASE}/wallet?status=pending`);
        }

        await applyConfirmedWalletTopup(strapi, {
          topupId: Number(topup.id),
          saleReferenceId,
          providerCode: settleCode,
          audit: {
            actor: {
              type: "webhook",
              id: "mellat-wallet-callback",
              label: "وب‌هوک درگاه ملت",
            },
            origin: "webhook",
            requestId: ctx.state?.auditRequestId || ctx.state?.requestId,
            correlationId: `wallet-topup:${topup.id}`,
          },
        });

        return ctx.redirect(`${FRONTEND_BASE}/wallet?status=success`);
      } catch (error) {
        if (
          saleReferenceId &&
          isUniqueConstraintError(error) &&
          (await findWalletTopupCredit(strapi, saleReferenceId))
        ) {
          return ctx.redirect(`${FRONTEND_BASE}/wallet?status=success`);
        }
        if (saleReferenceId) {
          const topups = (await strapi.entityService.findMany(WALLET_TOPUP_UID, {
            filters: { SaleOrderId: saleOrderId },
            limit: 1,
          })) as any[];
          if (topups?.[0]?.id) {
            await markWalletTopupUnknown(strapi, {
              topupId: Number(topups[0].id),
              error,
            }).catch(() => undefined);
          }
          return ctx.redirect(`${FRONTEND_BASE}/wallet?status=pending`);
        }
        return ctx.redirect(`${FRONTEND_BASE}/wallet?status=failure&reason=internal`);
      }
    },
  })
);
