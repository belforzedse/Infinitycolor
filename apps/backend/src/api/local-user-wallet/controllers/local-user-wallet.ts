/**
 * local-user-wallet controller
 */

import { factories } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../utils/roles";
import {
  creditWalletBalanceAtomic,
  deductWalletBalanceAtomic,
} from "../services/local-user-wallet";
import { recordAdminAudit } from "../../../utils/adminAudit";
import { getClientIp, getUserAgent } from "../../../utils/getClientIp";
import { requireCapability } from "../../../utils/adminAuthorization";

const WALLET_UID = "api::local-user-wallet.local-user-wallet";
const WALLET_TRANSACTION_UID =
  "api::local-user-wallet-transaction.local-user-wallet-transaction";

const rialToToman = (irr: number) => Math.round(Number(irr || 0) / 10);

/** Read a user's current wallet balance (IRR) without creating a wallet. */
async function readBalanceIrr(strapi: any, userId: number): Promise<number> {
  const wallet = await strapi.db
    .query(WALLET_UID)
    .findOne({ where: { user: userId }, select: ["id", "Balance"] });
  return wallet ? Number(wallet.Balance ?? 0) : 0;
}

export default factories.createCoreController(
  WALLET_UID,
  ({ strapi }) => ({
    async getCurrentUserWallet(ctx) {
      try {
        // Both native Strapi JWTs and Better Auth JWTs are resolved by the
        // registered content-API strategies before this controller runs.
        const pluginUserId = await resolveCustomerTargetUserId(ctx, strapi);
        if (!pluginUserId) return;

        // Find user's wallet
        const wallet = await strapi.db.query(WALLET_UID).findOne({
          where: {
            user: Number(pluginUserId),
          },
        });

        if (!wallet) {
          return ctx.notFound("Wallet not found for this user");
        }

        return ctx.send({
          success: true,
          data: {
            id: wallet.id,
            balance: wallet.Balance,
            lastTransactionDate: wallet.LastTransactionDate,
            description: wallet.Description,
          },
        });
      } catch (error) {
        strapi.log.error(error);
        return ctx.internalServerError(
          "An error occurred while fetching the wallet"
        );
      }
    },

    /**
     * Founder/Superadmin: read any customer's wallet balance for the admin UI.
     */
    async adminGetUserWallet(ctx: any) {
      try {
        const userId = Number(ctx.params.userId);
        if (!Number.isInteger(userId) || userId <= 0) {
          return ctx.badRequest("Invalid user id", {
            data: { success: false, errorCode: "INVALID_USER" },
          });
        }
        const user = await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({ where: { id: userId }, select: ["id"] });
        if (!user) {
          return ctx.notFound("User not found", {
            data: { success: false, errorCode: "USER_NOT_FOUND" },
          });
        }

        const balanceIrr = await readBalanceIrr(strapi, userId);
        return ctx.send({
          success: true,
          data: { balanceIrr, balanceToman: rialToToman(balanceIrr) },
        });
      } catch (error) {
        strapi.log.error("adminGetUserWallet failed", error);
        return ctx.internalServerError(
          "An error occurred while fetching the wallet"
        );
      }
    },

    async adminGetUserWalletHistory(ctx: any) {
      if (!(await requireCapability(ctx, strapi, "wallet.history.read"))) return;

      const userId = Number(ctx.params.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        return ctx.badRequest("Invalid user id", {
          data: { success: false, errorCode: "INVALID_USER" },
        });
      }

      const page = Math.max(1, Number.parseInt(String(ctx.query?.page ?? "1"), 10) || 1);
      const pageSize = Math.min(
        100,
        Math.max(1, Number.parseInt(String(ctx.query?.pageSize ?? "25"), 10) || 25),
      );
      const wallet = await strapi.db.query(WALLET_UID).findOne({
        where: { user: userId },
        select: ["id"],
      });
      if (!wallet) {
        return ctx.send({
          data: [],
          meta: { pagination: { page, pageSize, pageCount: 0, total: 0 } },
        });
      }

      const where = { user_wallet: wallet.id };
      const [transactions, total] = await Promise.all([
        strapi.db.query(WALLET_TRANSACTION_UID).findMany({
          where,
          select: [
            "id",
            "Amount",
            "Type",
            "Date",
            "Cause",
            "Note",
            "ReferenceId",
            "createdAt",
          ],
          orderBy: [{ Date: "desc" }, { id: "desc" }],
          limit: pageSize,
          offset: (page - 1) * pageSize,
        }),
        strapi.db.query(WALLET_TRANSACTION_UID).count({ where }),
      ]);

      return ctx.send({
        data: transactions,
        meta: {
          pagination: {
            page,
            pageSize,
            pageCount: Math.ceil(total / pageSize),
            total,
          },
        },
      });
    },

    /**
     * Founder/Superadmin: adjust another customer's wallet balance.
     * Supports credit/debit by an amount, or set-to-exact (implemented as the
     * credit/debit delta needed). Always records a ledger transaction and an
     * admin audit entry. Amounts are entered in Toman and stored in Rial (×10).
     */
    async adminAdjustWallet(ctx: any) {
      try {
        const body = ctx.request.body || {};
        const userId = Number(body.userId);
        const mode = body.mode as "credit" | "debit" | "set";
        const amountToman = Number(body.amountToman);
        const reason =
          typeof body.reason === "string" ? body.reason.trim() : "";

        if (!Number.isInteger(userId) || userId <= 0) {
          return ctx.badRequest("Invalid user id", {
            data: { success: false, errorCode: "INVALID_USER" },
          });
        }
        const actorId = Number(ctx.state?.user?.id);
        if (Number.isSafeInteger(actorId) && actorId > 0 && actorId === userId) {
          await recordAdminAudit(strapi, {
            resourceType: "User",
            resourceId: userId,
            action: "Adjust",
            title: "Rejected self-wallet adjustment",
            messageEn: "An administrator attempted to adjust their own wallet.",
            severity: "warning",
            actor: { id: actorId },
            metadata: { rejected: true, reasonCode: "SELF_WALLET_ADJUSTMENT_FORBIDDEN" },
            ip: getClientIp(ctx),
            userAgent: getUserAgent(ctx),
          });
          return ctx.forbidden("Administrators cannot adjust their own wallet", {
            data: { success: false, errorCode: "SELF_WALLET_ADJUSTMENT_FORBIDDEN" },
          });
        }
        if (!["credit", "debit", "set"].includes(mode)) {
          return ctx.badRequest("Invalid adjustment mode", {
            data: { success: false, errorCode: "INVALID_MODE" },
          });
        }
        if (!reason) {
          return ctx.badRequest("دلیل تغییر موجودی الزامی است", {
            data: { success: false, errorCode: "REASON_REQUIRED" },
          });
        }
        if (
          !Number.isFinite(amountToman) ||
          !Number.isInteger(amountToman) ||
          amountToman <= 0
        ) {
          return ctx.badRequest("مبلغ باید یک عدد صحیح مثبت باشد", {
            data: { success: false, errorCode: "INVALID_AMOUNT" },
          });
        }

        const user = await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({ where: { id: userId }, select: ["id"] });
        if (!user) {
          return ctx.notFound("User not found", {
            data: { success: false, errorCode: "USER_NOT_FOUND" },
          });
        }

        const amountIrr = amountToman * 10;
        const fromIrr = await readBalanceIrr(strapi, userId);

        // Resolve the signed delta to apply.
        let deltaIrr: number;
        if (mode === "credit") deltaIrr = amountIrr;
        else if (mode === "debit") deltaIrr = -amountIrr;
        else deltaIrr = amountIrr - fromIrr; // set: move current → target

        let toIrr = fromIrr;
        let txType: "Add" | "Minus" | null = null;

        if (deltaIrr > 0) {
          const result = await creditWalletBalanceAtomic(
            strapi,
            userId,
            deltaIrr
          );
          if (!result.success || result.walletId == null) {
            return ctx.badRequest(
              result.error || "Failed to credit wallet",
              { data: { success: false, errorCode: "CREDIT_FAILED" } }
            );
          }
          toIrr = Number(result.newBalance ?? fromIrr + deltaIrr);
          txType = "Add";
          await strapi.db.query(WALLET_TRANSACTION_UID).create({
            data: {
              Amount: deltaIrr,
              Type: "Add",
              Date: new Date(),
              Cause: "Admin Wallet Adjustment",
              Note: reason,
              ReferenceId: `admin-adj-${userId}-${Date.now()}`,
              user_wallet: result.walletId,
            },
          } as any);
        } else if (deltaIrr < 0) {
          const result = await deductWalletBalanceAtomic(
            strapi,
            userId,
            Math.abs(deltaIrr)
          );
          if (!result.success || result.walletId == null) {
            const insufficient = (result.error || "").includes("Insufficient");
            return ctx.badRequest(
              insufficient ? "موجودی کیف پول کافی نیست" : result.error || "Failed to debit wallet",
              {
                data: {
                  success: false,
                  errorCode: insufficient ? "INSUFFICIENT_BALANCE" : "DEBIT_FAILED",
                },
              }
            );
          }
          toIrr = Number(result.newBalance ?? fromIrr + deltaIrr);
          txType = "Minus";
          await strapi.db.query(WALLET_TRANSACTION_UID).create({
            data: {
              Amount: Math.abs(deltaIrr),
              Type: "Minus",
              Date: new Date(),
              Cause: "Admin Wallet Adjustment",
              Note: reason,
              ReferenceId: `admin-adj-${userId}-${Date.now()}`,
              user_wallet: result.walletId,
            },
          } as any);
        }
        // deltaIrr === 0 (set to current value): no-op, no transaction recorded.

        // Record the admin audit entry (fire-and-forget; never blocks the response).
        const actor = ctx.state.user;
        const fromToman = rialToToman(fromIrr);
        const toToman = rialToToman(toIrr);
        void recordAdminAudit(strapi, {
          resourceType: "User",
          resourceId: userId,
          action: "Adjust",
          title: "تنظیم کیف پول کاربر",
          message: `موجودی کیف پول کاربر #${userId} از ${fromToman.toLocaleString(
            "fa-IR"
          )} به ${toToman.toLocaleString("fa-IR")} تومان تغییر کرد. دلیل: ${reason}`,
          messageEn: `Wallet for user #${userId} changed from ${fromToman} to ${toToman} Toman (${mode}). Reason: ${reason}`,
          severity: "warning",
          changes: { Balance: { from: fromIrr, to: toIrr } },
          metadata: { mode, amountToman, txType },
          actor: actor
            ? { id: Number(actor.id), name: null, role: actor.role?.name ?? null }
            : undefined,
          ip: getClientIp(ctx),
          userAgent: getUserAgent(ctx),
        });

        return ctx.send({
          success: true,
          data: {
            balanceIrr: toIrr,
            balanceToman: toToman,
            changed: deltaIrr !== 0,
          },
        });
      } catch (error) {
        strapi.log.error("adminAdjustWallet failed", error);
        return ctx.internalServerError(
          "An error occurred while adjusting the wallet"
        );
      }
    },
  })
);
