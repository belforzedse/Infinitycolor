/**
 * local-user-wallet controller
 */

import { factories } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../utils/roles";
import {
  applyAdminWalletAdjustment,
  WalletAdjustmentError,
} from "../services/local-user-wallet";
import { writeAuditEvent } from "../../../audit/writer";
import { getAuditContext } from "../../../utils/audit-context";
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
          return ctx.send({
            success: true,
            data: {
              balance: 0,
            },
          });
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
     * Founder/Superadmin: read any user's wallet balance for the admin UI.
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
     * Founder/Superadmin: adjust another user's wallet balance.
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
          try {
            await writeAuditEvent(strapi, {
              eventKey: "security.access_denied",
              result: "denied",
              importance: "critical",
              initiator: { type: "human", id: actorId, label: ctx.state.user?.username },
              actor: { type: "service_account", id: "wallet-service", label: "Wallet Service" },
              origin: "admin_ui",
              target: { type: "customer", id: userId, label: `User ${userId}` },
              reasonCode: "SELF_WALLET_ADJUSTMENT_FORBIDDEN",
              metadata: { operation: "wallet.adjust" },
              ip: getClientIp(ctx),
              userAgent: getUserAgent(ctx),
              dedupeKey: `wallet-adjust:denied:self:${actorId}:${getAuditContext()?.requestId || Date.now()}`,
            });
          } catch (auditError) {
            strapi.log.error("Required denied-action audit write failed", {
              action: "wallet.adjust",
              reasonCode: "SELF_WALLET_ADJUSTMENT_FORBIDDEN",
              error: auditError instanceof Error ? auditError.message : String(auditError),
            });
          }
          return ctx.forbidden("تغییر موجودی کیف پول خودتان مجاز نیست.", {
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
        let adjustment;
        try {
          adjustment = await applyAdminWalletAdjustment(strapi, {
            userId,
            mode,
            amountIrr,
            reason,
            audit: {
              initiator: {
                type: "human",
                id: actorId,
                label: ctx.state.user?.username || ctx.state.user?.email || `User ${actorId}`,
                role: ctx.state.adminActor?.role || ctx.state.user?.role?.name || null,
              },
              actor: {
                type: "human",
                id: actorId,
                label: ctx.state.user?.username || ctx.state.user?.email || `User ${actorId}`,
              },
              origin: "admin_ui",
              ip: getClientIp(ctx),
              userAgent: getUserAgent(ctx),
              requestId: getAuditContext()?.requestId || null,
              correlationId: getAuditContext()?.correlationId || null,
            },
          });
        } catch (error) {
          if (error instanceof WalletAdjustmentError) {
            const insufficient = error.code === "INSUFFICIENT_BALANCE";
            return ctx.badRequest(
              insufficient ? "موجودی کیف پول کافی نیست" : error.message,
              {
                data: {
                  success: false,
                  errorCode: insufficient
                    ? "INSUFFICIENT_BALANCE"
                    : "WALLET_MUTATION_FAILED",
                },
              },
            );
          }
          throw error;
        }

        const toIrr = adjustment.afterBalance;
        const toToman = rialToToman(toIrr);

        return ctx.send({
          success: true,
          data: {
            balanceIrr: toIrr,
            balanceToman: toToman,
            changed: adjustment.changed,
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
