// @ts-nocheck
/**
 * wallet-topup controller
 *
 * Adding money to a wallet is a payment with no order behind it. The shape that
 * matters is therefore the same as checkout's: a durable, owner-bound intent
 * exists before any provider is contacted, the browser's return is treated as a
 * hint, and the credit is posted exactly once from a server-side verification.
 */

import { factories } from "@strapi/strapi";
import type { Strapi } from "@strapi/strapi";
import { resolveCustomerTargetUserId } from "../../../utils/roles";
import { requireCapability } from "../../../utils/adminAuthorization";
import { isWalletTopupEnabled } from "../../local-user-wallet/services/wallet-readiness";
import {
  applyConfirmedWalletTopup,
  bindWalletTopupProviderReference,
  claimWalletTopupCallback,
  claimWalletTopupForVerification,
  createWalletTopupIntent,
  findWalletTopupCredit,
  findWalletTopupForOwner,
  listWalletTopupsForOwner,
  listWalletTopupsNeedingReview,
  markWalletTopupFailed,
  markWalletTopupRedirected,
  markWalletTopupUnknown,
  WalletTopupIntentError,
} from "../services/wallet-topup";
import {
  initiateTopup,
  isTopupGatewayCode,
  parseTopupCallback,
  resolveTopupGateways,
  verifyTopup,
  walletTopupLimits,
} from "../services/topup-gateways";
import {
  normalizeWalletAmountInput,
  PaymentAllocationError,
  tomanToIrr,
} from "../../cart/services/lib/payment-allocation";

const FRONTEND_BASE = process.env.FRONTEND_URL || "https://infinitycolor.co";
const WALLET_TOPUP_UID = "api::wallet-topup.wallet-topup";

const walletRedirect = (
  saleOrderId: string,
  status: "success" | "pending" | "failure",
  reason?: string,
) => {
  const params = new URLSearchParams({ status });
  if (saleOrderId) params.set("topup", saleOrderId);
  if (reason) params.set("reason", reason);
  // Display only: the wallet page re-reads the real state from the server.
  return `${FRONTEND_BASE}/wallet?${params.toString()}`;
};

/**
 * Decides whether a callback may drive a *destructive* transition.
 *
 * Locating a row by a reference the caller supplied is not authorization. The
 * handle we persisted at initiation — Mellat's RefId, ZarinPal's authority — is
 * the one field that ties a callback to this specific attempt. When we hold no
 * such handle the callback simply cannot be correlated, and that is deliberately
 * not treated as permission to mutate: the intent stays open for reconciliation
 * rather than being flipped to Failed by anyone who can guess a reference.
 */
const isCallbackCorrelated = (topup: any, providerReference: string): boolean => {
  const persisted = String(topup?.provider_reference ?? topup?.ProviderReference ?? "").trim();
  if (!persisted) return false;
  return persisted === String(providerReference || "").trim();
};

const publicTopup = (row: any) => ({
  saleOrderId: String(row.sale_order_id ?? row.SaleOrderId ?? ""),
  status: String(row.status ?? row.Status ?? ""),
  gateway: String(row.gateway ?? row.Gateway ?? ""),
  amountToman: Math.floor(Number(row.amount ?? row.Amount ?? 0) / 10),
  amountIrr: Number(row.amount ?? row.Amount ?? 0),
  createdAt: row.created_at ?? row.createdAt ?? null,
  expiresAt: row.expires_at ?? row.ExpiresAt ?? null,
  reference: String(row.sale_reference_id ?? row.SaleReferenceId ?? "") || null,
});

export default factories.createCoreController(
  WALLET_TOPUP_UID,
  ({ strapi }: { strapi: Strapi }) => ({
    /**
     * What the storefront is allowed to offer. Always answered, so the wallet
     * page never has to infer a feature flag from a failed request.
     */
    async topupOptions(ctx) {
      const userId = await resolveCustomerTargetUserId(ctx, strapi);
      if (!userId) return;

      const limits = walletTopupLimits();
      const enabled = isWalletTopupEnabled();
      const gateways = enabled ? await resolveTopupGateways(strapi) : [];
      return ctx.send({
        data: {
          success: true,
          // Both halves matter: the operator switch and whether the database
          // prerequisites actually verified.
          enabled: enabled && gateways.length > 0,
          disabledReason: !enabled
            ? "disabled"
            : gateways.length === 0
              ? "no_gateway"
              : null,
          gateways,
          minToman: limits.minToman,
          maxToman: limits.maxToman,
          presetsToman: limits.presetsToman,
          maxPending: limits.maxPending,
        },
      });
    },

    async chargeIntent(ctx) {
      const userId = await resolveCustomerTargetUserId(ctx, strapi);
      if (!userId) return;

      const body = ctx.request.body || {};
      const limits = walletTopupLimits();

      if (!isWalletTopupEnabled()) {
        return ctx.badRequest("افزایش موجودی کیف پول در حال حاضر غیرفعال است.", {
          data: { success: false, errorCode: "WALLET_TOPUP_DISABLED" },
        });
      }

      let amountIrr: number;
      try {
        if (body.amountToman !== undefined && body.amountToman !== null && body.amountToman !== "") {
          const amountToman = normalizeWalletAmountInput(body.amountToman);
          if (amountToman < limits.minToman || amountToman > limits.maxToman) {
            return ctx.badRequest(
              `مبلغ باید بین ${limits.minToman} و ${limits.maxToman} تومان باشد.`,
              {
                data: {
                  success: false,
                  errorCode: "WALLET_TOPUP_AMOUNT_OUT_OF_RANGE",
                  minToman: limits.minToman,
                  maxToman: limits.maxToman,
                },
              },
            );
          }
          amountIrr = tomanToIrr(amountToman);
        } else {
          // Legacy callers send IRR directly. Kept working, bounds still apply.
          amountIrr = normalizeWalletAmountInput(body.amount);
          const asToman = Math.floor(amountIrr / 10);
          if (asToman < limits.minToman || asToman > limits.maxToman) {
            return ctx.badRequest(
              `مبلغ باید بین ${limits.minToman} و ${limits.maxToman} تومان باشد.`,
              {
                data: {
                  success: false,
                  errorCode: "WALLET_TOPUP_AMOUNT_OUT_OF_RANGE",
                  minToman: limits.minToman,
                  maxToman: limits.maxToman,
                },
              },
            );
          }
        }
      } catch (error) {
        if (!(error instanceof PaymentAllocationError)) throw error;
        return ctx.badRequest(error.message, {
          data: { success: false, errorCode: "WALLET_TOPUP_AMOUNT_INVALID" },
        });
      }

      const gateways = await resolveTopupGateways(strapi);
      const requested = String(body.gateway || "").trim();
      const gateway = requested
        ? gateways.find((entry) => entry.code.toLowerCase() === requested.toLowerCase())?.code
        : gateways[0]?.code;
      if (!gateway || !isTopupGatewayCode(gateway)) {
        return ctx.badRequest("درگاه انتخاب‌شده برای افزایش موجودی در دسترس نیست.", {
          data: { success: false, errorCode: "WALLET_TOPUP_GATEWAY_UNAVAILABLE", gateways },
        });
      }

      let intent;
      try {
        intent = await createWalletTopupIntent(strapi, {
          userId,
          amountIrr,
          gateway,
          idempotencyKey: body.idempotencyKey,
        });
      } catch (error) {
        if (error instanceof WalletTopupIntentError) {
          return ctx.badRequest(error.message, {
            data: { success: false, errorCode: error.code, ...error.details },
          });
        }
        throw error;
      }

      const saleOrderId = String(intent.topup.SaleOrderId);

      // The same request replayed with the same key returns the same intent. If
      // it already has a provider session, hand back the original redirect
      // instead of opening a second one.
      if (intent.reused && intent.topup.RefId) {
        return ctx.send({
          data: {
            success: true,
            reused: true,
            saleOrderId,
            gateway: intent.topup.Gateway,
            refId: intent.topup.RefId,
            redirectUrl: intent.topup.Note || "",
          },
        });
      }

      let initiation;
      try {
        initiation = await initiateTopup(strapi, {
          gateway,
          saleOrderId,
          amountIrr,
          mobile: body.mobile,
        });
      } catch (error) {
        // An exception before any answer is an unknown outcome, not a refusal.
        await markWalletTopupUnknown(strapi, {
          topupId: Number(intent.topup.id),
          error,
        }).catch(() => undefined);
        strapi.log.error(
          `Wallet top-up initiation threw for ${saleOrderId} on ${gateway}: ${String(
            (error as any)?.message || error,
          ).slice(0, 200)}`,
        );
        ctx.status = 202;
        return {
          data: {
            success: false,
            errorCode: "WALLET_TOPUP_UNKNOWN",
            message: "پرداخت در حال بررسی است. لطفاً دوباره پرداخت نکنید.",
            saleOrderId,
          },
        };
      }

      if (initiation.outcome === "failed") {
        await markWalletTopupFailed(strapi, {
          topupId: Number(intent.topup.id),
          error: initiation.message,
        });
        return ctx.badRequest("درگاه پرداخت درخواست را نپذیرفت.", {
          data: { success: false, errorCode: initiation.errorCode, saleOrderId },
        });
      }

      if (initiation.outcome === "unknown") {
        await markWalletTopupUnknown(strapi, {
          topupId: Number(intent.topup.id),
          error: initiation.message,
        });
        ctx.status = 202;
        return {
          data: {
            success: false,
            errorCode: "WALLET_TOPUP_UNKNOWN",
            message: "پرداخت در حال بررسی است. لطفاً دوباره پرداخت نکنید.",
            saleOrderId,
          },
        };
      }

      // Persisted before the customer is sent anywhere. A redirect issued while
      // the handle is still only in memory produces a payable session we could
      // not recognise on the way back.
      const persisted = await markWalletTopupRedirected(strapi, {
        topupId: Number(intent.topup.id),
        // Saman only reveals its verification handle (RefNum) on the callback.
        providerReference: gateway === "SamanKish" ? null : initiation.providerReference,
        initiationToken: initiation.providerReference,
      });
      if (!persisted) {
        await markWalletTopupUnknown(strapi, {
          topupId: Number(intent.topup.id),
          error: "Provider session could not be persisted before redirect",
        }).catch(() => undefined);
        ctx.status = 202;
        return {
          data: {
            success: false,
            errorCode: "WALLET_TOPUP_UNKNOWN",
            message: "پرداخت در حال بررسی است. لطفاً دوباره پرداخت نکنید.",
            saleOrderId,
          },
        };
      }

      return ctx.send({
        data: {
          success: true,
          saleOrderId,
          gateway,
          refId: initiation.providerReference,
          redirectUrl: initiation.redirectUrl,
          redirectMethod: initiation.method,
          formFields: initiation.formFields,
        },
      });
    },

    /** Owner-scoped status, so the wallet page never has to trust its own query string. */
    async myTopup(ctx) {
      const userId = await resolveCustomerTargetUserId(ctx, strapi);
      if (!userId) return;
      const row = await findWalletTopupForOwner(strapi, {
        userId,
        saleOrderId: String(ctx.params?.saleOrderId || "").trim(),
      });
      if (!row) return ctx.notFound("درخواست افزایش موجودی یافت نشد");
      return ctx.send({ data: { success: true, topup: publicTopup(row) } });
    },

    async myTopups(ctx) {
      const userId = await resolveCustomerTargetUserId(ctx, strapi);
      if (!userId) return;
      const rows = await listWalletTopupsForOwner(strapi, {
        userId,
        limit: Number(ctx.query?.limit || 20),
      });
      return ctx.send({ data: { success: true, topups: rows.map(publicTopup) } });
    },

    /**
     * Intents the reconciliation ladder gave up on, for an operator to settle
     * by hand. Capability-gated on wallet history rather than on a role name,
     * and it never mutates anything — deciding what happened to the money is
     * the operator's call, made with the provider's own records.
     */
    async adminReviewTopups(ctx) {
      if (!(await requireCapability(ctx, strapi, "wallet.history.read"))) return;

      const rows = await listWalletTopupsNeedingReview(strapi, {
        limit: Number(ctx.query?.limit || 50),
      });
      return ctx.send({
        data: {
          success: true,
          topups: rows.map((row: any) => ({
            ...publicTopup(row),
            id: Number(row.id),
            userId: row.user_id == null ? null : Number(row.user_id),
            owner: String(row.owner_username || row.owner_phone || "") || null,
            providerReference: String(row.provider_reference || "") || null,
            reconcileAttempts: Number(row.reconcile_attempts || 0),
            lastProviderCode: row.last_provider_code ?? null,
            lastProviderError: row.last_provider_error ?? null,
            updatedAt: row.updated_at ?? null,
          })),
        },
      });
    },

    /**
     * The provider's return. Routed for both GET and POST: Mellat posts a form,
     * ZarinPal sends the browser back with `?Authority=&Status=`.
     */
    async paymentCallback(ctx) {
      const callback = parseTopupCallback({
        query: ctx.request?.query || ctx.query,
        body: ctx.request?.body,
      });
      if (!callback) {
        return ctx.redirect(walletRedirect("", "failure", "invalid_callback"));
      }

      const saleOrderId = String(callback.saleOrderId || "");
      let resolvedTopupId: number | null = null;
      try {
        // ZarinPal does not echo our reference, and it does not need to: the
        // authority it minted is stored on the intent, so the lookup is bound
        // through our own record rather than through a client-supplied id.
        const where = callback.providerReference && callback.gateway === "ZarinPal"
          ? { ProviderReference: callback.providerReference }
          : saleOrderId
            ? { SaleOrderId: saleOrderId }
            : null;
        if (!where) {
          return ctx.redirect(walletRedirect(saleOrderId, "failure", "invalid_callback"));
        }

        const topup: any = await strapi.db.query(WALLET_TOPUP_UID).findOne({
          where,
          populate: { user: true },
        } as any);
        if (!topup) {
          return ctx.redirect(walletRedirect(saleOrderId, "failure", "not_found"));
        }

        resolvedTopupId = Number(topup.id);
        const reference = String(topup.SaleOrderId || saleOrderId);
        const storedGateway = String(topup.Gateway || "Mellat");
        // The intent's own persisted gateway decides how it is verified — never
        // a field the caller chose.
        if (storedGateway !== callback.gateway) {
          strapi.log.error(
            `Wallet top-up ${topup.id} received a ${callback.gateway} callback but is a ${storedGateway} intent`,
          );
          return ctx.redirect(walletRedirect(reference, "failure", "unverified"));
        }

        if (String(topup.Status) === "Success") {
          return ctx.redirect(walletRedirect(reference, "success"));
        }

        // Saman only reveals the handle its verification API takes on the way
        // back, so bind it now — CAS'd, so a second callback cannot repoint the
        // intent at a different transaction.
        if (storedGateway === "SamanKish" && callback.providerReference) {
          const bound = await bindWalletTopupProviderReference(strapi, {
            topupId: Number(topup.id),
            providerReference: callback.providerReference,
          });
          if (!bound) {
            strapi.log.error(
              `Wallet top-up ${topup.id} already carries a different Saman reference than this callback`,
            );
            return ctx.redirect(walletRedirect(reference, "failure", "unverified"));
          }
          topup.ProviderReference = callback.providerReference;
        }

        const correlated = isCallbackCorrelated(topup, callback.providerReference || "");

        if (!callback.declaredSuccess) {
          if (!correlated) {
            strapi.log.error(
              `Wallet top-up ${topup.id} failure callback could not be correlated; leaving the attempt untouched`,
            );
            return ctx.redirect(walletRedirect(reference, "pending", "unverified"));
          }
          await markWalletTopupFailed(strapi, {
            topupId: Number(topup.id),
            providerCode: Number.isFinite(Number(callback.rawCode))
              ? Number(callback.rawCode)
              : null,
            error: `${storedGateway} callback reported failure ${callback.rawCode || ""}`,
            allowedFrom: ["Pending", "Processing", "Unknown"],
          });
          return ctx.redirect(walletRedirect(reference, "failure", "declined"));
        }

        // A success callback whose handle does not match the one we stored is
        // pointing at a different attempt, so nothing is mutated. An intent that
        // never recorded a handle at all is a different case: the provider
        // verification below is keyed on our own reference and only succeeds if
        // the provider agrees that transaction settled, which is stronger
        // evidence than the echoed handle. Refusing those would strand money
        // that was genuinely taken.
        const hasStoredHandle = Boolean(
          String(topup.ProviderReference ?? "").trim(),
        );
        if (hasStoredHandle && !correlated) {
          strapi.log.error(
            `Wallet top-up ${topup.id} success callback handle does not match the stored reference`,
          );
          return ctx.redirect(walletRedirect(reference, "pending", "unverified"));
        }

        const amountIrr = Number(topup.Amount || 0);

        if (storedGateway === "Mellat") {
          const saleReferenceId = String(callback.saleReferenceId || "");
          if (!saleReferenceId) {
            return ctx.redirect(walletRedirect(reference, "failure", "invalid_callback"));
          }
          if (await findWalletTopupCredit(strapi, saleReferenceId, undefined, storedGateway)) {
            return ctx.redirect(walletRedirect(reference, "success"));
          }
          if (!(await claimWalletTopupCallback(strapi, Number(topup.id), saleReferenceId))) {
            const current: any = await strapi.db.query(WALLET_TOPUP_UID).findOne({
              where: { id: Number(topup.id) },
              select: ["Status"],
            } as any);
            if (
              current?.Status === "Success" ||
              (await findWalletTopupCredit(strapi, saleReferenceId, undefined, storedGateway))
            ) {
              return ctx.redirect(walletRedirect(reference, "success"));
            }
            return ctx.redirect(walletRedirect(reference, "pending"));
          }
        } else if (!(await claimWalletTopupForVerification(strapi, Number(topup.id)))) {
          const current: any = await strapi.db.query(WALLET_TOPUP_UID).findOne({
            where: { id: Number(topup.id) },
            select: ["Status"],
          } as any);
          return ctx.redirect(
            walletRedirect(reference, current?.Status === "Success" ? "success" : "pending"),
          );
        }

        const verification = await verifyTopup(strapi, {
          gateway: storedGateway as any,
          saleOrderId: reference,
          amountIrr,
          providerReference: String(topup.ProviderReference || callback.providerReference || ""),
          saleReferenceId: callback.saleReferenceId,
        });

        if (verification.outcome === "failed") {
          await markWalletTopupFailed(strapi, {
            topupId: Number(topup.id),
            providerCode: verification.providerCode,
            error: verification.message,
            allowedFrom: ["Pending", "Processing", "Unknown"],
          });
          return ctx.redirect(walletRedirect(reference, "failure", "declined"));
        }
        if (verification.outcome === "unknown") {
          await markWalletTopupUnknown(strapi, {
            topupId: Number(topup.id),
            providerCode: verification.providerCode,
            error: verification.message,
          });
          return ctx.redirect(walletRedirect(reference, "pending"));
        }

        await applyConfirmedWalletTopup(strapi, {
          topupId: Number(topup.id),
          saleReferenceId: verification.providerReference,
          providerCode: verification.providerCode,
          audit: {
            actor: {
              type: "webhook",
              id: `${storedGateway.toLowerCase()}-wallet-callback`,
              label: "وب‌هوک درگاه پرداخت",
            },
            origin: "webhook",
            requestId: ctx.state?.auditRequestId || ctx.state?.requestId,
            correlationId: `wallet-topup:${topup.id}`,
          },
        });
        return ctx.redirect(walletRedirect(reference, "success"));
      } catch (error) {
        // Remote verification may have succeeded before local posting failed, so
        // the intent is parked Unknown for the reconciler to finish rather than
        // being closed either way.
        if (resolvedTopupId) {
          await markWalletTopupUnknown(strapi, {
            topupId: resolvedTopupId,
            error,
          }).catch(() => undefined);
        }
        strapi.log.error(
          `Wallet top-up callback failed for ${saleOrderId || callback.providerReference}: ${String(
            (error as any)?.message || error,
          ).slice(0, 300)}`,
        );
        return ctx.redirect(walletRedirect(saleOrderId, "pending", "processing"));
      }
    },
  }),
);
