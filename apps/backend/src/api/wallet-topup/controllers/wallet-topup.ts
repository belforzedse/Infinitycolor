// @ts-nocheck
/**
 * wallet-topup controller
 */

import { factories } from "@strapi/strapi";
import type { Strapi } from "@strapi/strapi";
import { creditWalletBalanceAtomic } from "../../local-user-wallet/services/local-user-wallet";
import { resolveCustomerTargetUserId } from "../../../utils/roles";

const FRONTEND_BASE =
  process.env.FRONTEND_URL || "https://infinitycolor.co";

const WALLET_TRANSACTION_UID =
  "api::local-user-wallet-transaction.local-user-wallet-transaction";
const WALLET_TOPUP_UID = "api::wallet-topup.wallet-topup";

async function findWalletCreditByReference(
  strapi: Strapi,
  referenceId: string,
  trx?: any
) {
  if (!referenceId) return null;
  return strapi.db.query(WALLET_TRANSACTION_UID).findOne({
    where: { ReferenceId: referenceId },
    select: ["id"],
    transacting: trx,
  } as any);
}

async function lockWalletTopupForUpdate(strapi: Strapi, topupId: number, trx: any) {
  const runner = trx?.raw ? trx : strapi.db.connection;
  const result = await runner.raw(
    `SELECT id, amount, status, sale_reference_id
     FROM wallet_topups
     WHERE id = ?
     FOR UPDATE`,
    [topupId]
  );
  return (result.rows || [])[0] || null;
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
      const { ResCode, SaleOrderId, SaleReferenceId } = (ctx.request as any).body || {};
      const saleOrderId = String(SaleOrderId ?? "").trim();
      const saleReferenceId = String(SaleReferenceId ?? "").trim();

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

        const resCode = String(ResCode ?? "").trim();
        if (resCode !== "0") {
          try {
            await strapi.entityService.update(
              WALLET_TOPUP_UID,
              topup.id,
              { data: { Status: "Failed" } }
            );
          } catch (e) {
            strapi.log.error(
              "Failed to mark wallet topup as Failed (cancelled)",
              {
                topupId: topup.id,
                saleOrderId: String(SaleOrderId || ""),
                error: (e as any)?.message || String(e),
              }
            );
          }
          return ctx.redirect(
            `${FRONTEND_BASE}/wallet?status=failure&code=${encodeURIComponent(resCode)}`
          );
        }

        if (!saleReferenceId) {
          return ctx.redirect(
            `${FRONTEND_BASE}/wallet?status=failure&reason=invalid_callback`
          );
        }

        if (await findWalletCreditByReference(strapi, saleReferenceId)) {
          return ctx.redirect(`${FRONTEND_BASE}/wallet?status=success`);
        }

        const result = await strapi.db.transaction(async ({ trx }) => {
          const lockedTopup = await lockWalletTopupForUpdate(strapi, topup.id, trx);
          if (!lockedTopup) {
            return { status: "not_found" };
          }

          if (await findWalletCreditByReference(strapi, saleReferenceId, trx)) {
            return { status: "success" };
          }

          const lockedStatus = lockedTopup.status ?? lockedTopup.Status;
          if (lockedStatus === "Success") {
            return { status: "success" };
          }

          const verifyResult = await paymentService.verifyTransaction({
            orderId: saleOrderId,
            saleOrderId,
            saleReferenceId,
          });

          if (!verifyResult?.success) {
            return { status: "verify_failed", verifyResult };
          }

          const settleResult = await paymentService.settleTransaction({
            orderId: saleOrderId,
            saleOrderId,
            saleReferenceId,
          });

          if (!settleResult?.success) {
            return { status: "settle_failed", settleResult };
          }

          const amount = Number(lockedTopup.amount ?? lockedTopup.Amount ?? topup.Amount);
          const userId = Number(topup.user?.id);
          const walletResult = await creditWalletBalanceAtomic(
            strapi,
            userId,
            amount,
            trx
          );

          if (!walletResult.success || !walletResult.walletId) {
            throw new Error(walletResult.error || "Failed to credit wallet");
          }

          await strapi.db.query(WALLET_TRANSACTION_UID).create({
            data: {
              Amount: amount,
              Type: "Add",
              Date: new Date(),
              Cause: "Wallet Topup",
              ReferenceId: saleReferenceId,
              user_wallet: walletResult.walletId,
            },
            transacting: trx,
          } as any);

          await strapi.db.query(WALLET_TOPUP_UID).update({
            where: { id: topup.id },
            data: {
              Status: "Success",
              SaleReferenceId: saleReferenceId,
            },
            transacting: trx,
          } as any);

          return { status: "success" };
        });

        if (result?.status === "not_found") {
          return ctx.redirect(
            `${FRONTEND_BASE}/wallet?status=failure&reason=not_found`
          );
        }

        if (result?.status === "verify_failed") {
          strapi.log.error("Wallet topup verify failed", {
            topupId: topup.id,
            saleOrderId,
            verifyResult: result.verifyResult,
          });
          try {
            await strapi.entityService.update(
              WALLET_TOPUP_UID,
              topup.id,
              { data: { Status: "Failed" } }
            );
          } catch (e) {
            strapi.log.error("Failed to mark topup as Failed after verify failure", {
              topupId: topup.id,
              error: (e as any)?.message || String(e),
            });
          }
          return ctx.redirect(
            `${FRONTEND_BASE}/wallet?status=failure&reason=verify`
          );
        }

        if (result?.status === "settle_failed") {
          strapi.log.error("Wallet topup settle failed", {
            topupId: topup.id,
            saleOrderId,
            settleResult: result.settleResult,
          });
          try {
            await strapi.entityService.update(
              WALLET_TOPUP_UID,
              topup.id,
              { data: { Status: "Failed" } }
            );
          } catch (e) {
            strapi.log.error("Failed to mark topup as Failed after settle failure", {
              topupId: topup.id,
              error: (e as any)?.message || String(e),
            });
          }
          return ctx.redirect(
            `${FRONTEND_BASE}/wallet?status=failure&reason=settle`
          );
        }

        return ctx.redirect(`${FRONTEND_BASE}/wallet?status=success`);
      } catch (error) {
        if (
          saleReferenceId &&
          isUniqueConstraintError(error) &&
          (await findWalletCreditByReference(strapi, saleReferenceId))
        ) {
          return ctx.redirect(`${FRONTEND_BASE}/wallet?status=success`);
        }

        return ctx.redirect(
          `${FRONTEND_BASE}/wallet?status=failure&reason=internal`
        );
      }
    },
  })
);
