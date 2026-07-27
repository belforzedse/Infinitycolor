import type { Strapi } from "@strapi/strapi";
import { recordAdminAudit } from "../../../../utils/adminAudit";
import { getClientIp, getUserAgent } from "../../../../utils/getClientIp";
import { OPERATIONAL_ROLES, roleIsAllowed } from "../../../../utils/roles";
import { isSnappayGatewayValue } from "../../../payment-gateway/services/checkout-gateway-availability";
import {
  decryptSnappaySecret,
  displaySnappayFingerprint,
} from "../../../payment-gateway/services/snappay-security";

const TRANSACTION_UID = "api::contract-transaction.contract-transaction" as const;

export async function adminRevealSnappayTokenHandler(strapi: Strapi, ctx: any) {
  const orderId = Number(ctx.params?.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return ctx.badRequest("Invalid order id");
  }

  const actor = ctx.state?.user;
  const fullUser: any = actor?.id
    ? await strapi.db.query("plugin::users-permissions.user").findOne({
        where: { id: actor.id },
        populate: ["role"],
      } as any)
    : null;
  if (!fullUser || !roleIsAllowed(fullUser?.role?.name, OPERATIONAL_ROLES)) {
    return ctx.forbidden("Admin access required");
  }

  const order: any = await strapi.db.query("api::order.order").findOne({
    where: { id: orderId },
    populate: { contract: true },
  } as any);
  if (!order) return ctx.notFound("Order not found");
  if (
    !isSnappayGatewayValue(order.PaymentGateway) &&
    !isSnappayGatewayValue(order.contract?.external_source)
  ) {
    return ctx.conflict("Order is not a SnappPay order", {
      data: { error: "SNAPPAY_ORDER_REQUIRED" },
    });
  }
  const contractId = Number(order.contract?.id);
  if (!Number.isInteger(contractId) || contractId <= 0) {
    return ctx.conflict("SnappPay contract was not found", {
      data: { error: "SNAPPAY_CONTRACT_NOT_FOUND" },
    });
  }

  const attempt: any = await strapi.db.query("api::payment-attempt.payment-attempt").findOne({
    where: {
      order: { id: orderId },
      Gateway: "snappay",
    },
    orderBy: { createdAt: "desc" },
  } as any);
  const transactions: any[] = await strapi.db.query(TRANSACTION_UID).findMany({
    where: { contract: { id: contractId } },
    orderBy: { createdAt: "desc" },
    limit: 100,
  } as any);
  const providerReference = String(attempt?.providerReference || "").trim();
  const transaction = providerReference
    ? transactions.find(
        (candidate) =>
          isSnappayGatewayValue(candidate?.external_source) &&
          String(candidate?.external_id || "") === providerReference,
      )
    : transactions.find((candidate) => isSnappayGatewayValue(candidate?.external_source));
  if (!transaction) {
    return ctx.conflict("SnappPay transaction was not found", {
      data: { error: "SNAPPAY_TRANSACTION_NOT_FOUND" },
    });
  }

  const hasEncryptedToken = Boolean(String(transaction.PaymentTokenCiphertext || "").trim());
  const legacyPaymentToken = String(transaction.TrackId || "").trim();
  const storage: "encrypted" | "legacy_plaintext" = hasEncryptedToken
    ? "encrypted"
    : "legacy_plaintext";
  if (!hasEncryptedToken && !legacyPaymentToken) {
    return ctx.conflict("SnappPay payment token is not available", {
      data: { error: "SNAPPAY_PAYMENT_TOKEN_NOT_AVAILABLE" },
    });
  }

  const auditRecorded = await recordAdminAudit(strapi, {
    resourceType: "Order",
    resourceId: orderId,
    action: "Other",
    title: "درخواست نمایش توکن پشتیبانی اسنپ‌پی تأیید شد",
    message: `درخواست نمایش توکن پشتیبانی اسنپ‌پی برای سفارش #${orderId} تأیید شد`,
    messageEn: `Authorized SnappPay support-token reveal requested for order #${orderId}`,
    severity: "warning",
    description: `Authorized SnappPay support-token reveal requested for order #${orderId}`,
    metadata: {
      operation: "snappay_token_reveal",
      transactionId: providerReference || transaction.external_id || null,
      storage,
    },
    actor: {
      id: Number(fullUser.id),
      role: fullUser.role?.name,
    },
    ip: getClientIp(ctx),
    userAgent: getUserAgent(ctx),
  });
  if (!auditRecorded) {
    return ctx.internalServerError("SnappPay token access could not be audited", {
      data: { error: "SNAPPAY_TOKEN_AUDIT_FAILED" },
    });
  }

  let paymentToken = legacyPaymentToken;
  if (hasEncryptedToken) {
    try {
      paymentToken = decryptSnappaySecret(String(transaction.PaymentTokenCiphertext));
    } catch {
      return ctx.conflict("SnappPay payment token cannot be decrypted", {
        data: { error: "SNAPPAY_PAYMENT_TOKEN_UNRECOVERABLE" },
      });
    }
  }
  if (!paymentToken) {
    return ctx.conflict("SnappPay payment token is not available", {
      data: { error: "SNAPPAY_PAYMENT_TOKEN_NOT_AVAILABLE" },
    });
  }

  ctx.set?.("Cache-Control", "no-store, private");
  ctx.set?.("Pragma", "no-cache");

  return {
    data: {
      paymentToken,
      transactionId: providerReference || transaction.external_id || null,
      providerStatus: attempt?.providerStatus || transaction.GatewayStatus || null,
      fingerprint: displaySnappayFingerprint(String(transaction.PaymentTokenHash || "")) || null,
    },
  };
}
