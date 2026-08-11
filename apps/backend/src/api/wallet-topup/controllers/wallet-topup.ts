// @ts-nocheck
/**
 * wallet-topup controller
 */

import { factories } from "@strapi/strapi";
import type { Strapi } from "@strapi/strapi";
import { creditWalletBalanceAtomic } from "../../local-user-wallet/services/local-user-wallet";
import { resolveCustomerTargetUserId } from "../../../utils/roles";
import { runRawSql } from "../../../utils/transactionExecutor";

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

/**
 * Marks a top-up Failed, but only from Pending.
 *
 * `/api/wallet/payment-callback` is unauthenticated, so the failure branch is the one an
 * attacker would aim at. The guarded UPDATE is what makes duplicate failures harmless and
 * makes it impossible for a late or forged failure to overwrite a Success that already
 * credited the wallet.
 */
async function markWalletTopupFailed(
  strapi: Strapi,
  topupId: number,
  trx?: any
): Promise<boolean> {
  try {
    const result = await runRawSql(
      strapi,
      `UPDATE wallet_topups
       SET status = 'Failed'
       WHERE id = ?
         AND status = 'Pending'
       RETURNING id`,
      [topupId],
      trx
    );
    return (result?.rows || []).length === 1;
  } catch (error: any) {
    strapi.log.error("Failed to transition wallet topup to Failed", {
      topupId,
      error: error?.message || String(error),
    });
    return false;
  }
}

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

          await markWalletTopupFailed(strapi, Number(topup.id));
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
          // Guarded like every other failure transition: this must not be able to
          // overwrite a Success committed by a concurrent callback.
          await markWalletTopupFailed(strapi, Number(topup.id));
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
          await markWalletTopupFailed(strapi, Number(topup.id));
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
