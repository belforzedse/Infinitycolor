import { claimSmsIdempotency, releaseSmsIdempotency, buildSmsIdempotencyKey } from "./idempotency";
import { sendPatternSms } from "./ippanel";
import { loadSmsConfig } from "./config";
import { maskPhone } from "./redaction";
import type {
  SmsNotificationType,
  SmsPatternParams,
  SmsSendResult,
  StrapiSmsLike,
} from "./types";

const NOTIFIABLE_STATUSES = new Set(["Started", "Shipment", "Done", "Cancelled"]);

const STATUS_TYPE: Record<string, SmsNotificationType> = {
  Started: "order_status_updated",
  Shipment: "shipped",
  Done: "order_status_updated",
  Cancelled: "cancelled",
};

const STATUS_LABELS: Record<string, string> = {
  Started: "پرداخت شده و در حال آماده‌سازی",
  Shipment: "ارسال شده",
  Done: "تکمیل شده",
  Cancelled: "لغو شده",
};

const CANCELLATION_REASON_LABELS: Record<string, string> = {
  customer_request: "درخواست مشتری",
  user_request: "درخواست مشتری",
  requested_by_customer: "درخواست مشتری",
  out_of_stock: "ناموجود بودن کالا",
  unavailable: "ناموجود بودن کالا",
  inventory_unavailable: "ناموجود بودن کالا",
  payment_failed: "تکمیل نشدن پرداخت",
  payment_expired: "منقضی شدن پرداخت",
  duplicate_order: "ثبت سفارش تکراری",
  admin_cancelled: "لغو توسط پشتیبانی",
  support_cancelled: "لغو توسط پشتیبانی",
};

const DEFAULT_CANCELLATION_REASON = "لغو سفارش توسط پشتیبانی";
const SMS_PATTERN_PARAM_MAX_LENGTH = 40;

function trimSmsParam(value?: string | number | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > SMS_PATTERN_PARAM_MAX_LENGTH
    ? normalized.slice(0, SMS_PATTERN_PARAM_MAX_LENGTH)
    : normalized;
}

function normalizeReasonKey(reason: string): string {
  return reason
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function looksLikeInternalReason(reason: string): boolean {
  return /^[a-z0-9_\-\s]+$/i.test(reason);
}

export function formatOrderStatusForSms(status?: string | null): string | undefined {
  if (!status) return undefined;
  return trimSmsParam(STATUS_LABELS[status] || status);
}

export function formatCancellationReasonForSms(reason?: string | null): string {
  const clean = trimSmsParam(reason);
  if (!clean) return DEFAULT_CANCELLATION_REASON;

  const mapped = CANCELLATION_REASON_LABELS[normalizeReasonKey(clean)];
  if (mapped) return mapped;

  return looksLikeInternalReason(clean) ? DEFAULT_CANCELLATION_REASON : clean;
}

export function isNotifiableOrderStatus(status?: string | null): boolean {
  return !!status && NOTIFIABLE_STATUSES.has(status);
}

export function notificationTypeForStatus(status: string): SmsNotificationType {
  return STATUS_TYPE[status] || "order_status_updated";
}

export function buildOrderNotificationParams(input: {
  orderId: string | number;
  status?: string | null;
  amount?: string | number | null;
  trackingCode?: string | null;
  reason?: string | null;
  code?: string | number | null;
}): SmsPatternParams {
  return {
    code: input.code ?? input.orderId,
    orderId: input.orderId,
    status: formatOrderStatusForSms(input.status),
    trackingCode: input.trackingCode,
    amount: input.amount,
    reason:
      input.reason === undefined || input.reason === null
        ? undefined
        : formatCancellationReasonForSms(input.reason),
  };
}

function extractUserPhone(order: any): string | null {
  return (
    order?.user?.phone ||
    order?.user?.Phone ||
    order?.user?.mobile ||
    order?.user?.user_info?.Phone ||
    order?.user_info?.Phone ||
    order?.delivery_address?.Phone ||
    null
  );
}

function extractUserId(order: any): number | undefined {
  const id = order?.user?.id ?? order?.user;
  const numeric = Number(id);
  return Number.isFinite(numeric) ? numeric : undefined;
}

async function loadOrderForSms(strapi: StrapiSmsLike, orderId: number): Promise<any> {
  if (!strapi.entityService?.findOne) return null;
  return strapi.entityService.findOne("api::order.order", orderId, {
    populate: {
      user: { populate: { user_info: true } },
      user_info: true,
      delivery_address: true,
      contract: true,
    },
  });
}

async function sendOrderSms(params: {
  strapi: StrapiSmsLike;
  type: SmsNotificationType;
  order: any;
  variables: SmsPatternParams;
  fingerprint: string;
}): Promise<SmsSendResult> {
  const { strapi, type, order, variables, fingerprint } = params;
  const phone = extractUserPhone(order);
  const orderId = order?.id;
  const key = buildSmsIdempotencyKey({
    type,
    orderId,
    userId: extractUserId(order),
    fingerprint,
  });

  const finish = async (result: SmsSendResult): Promise<SmsSendResult> => {
    try {
      await strapi.db?.query?.("api::order-log.order-log")?.create?.({
        data: {
          order: Number(orderId),
          Action: "Update",
          Description: "Customer SMS delivery outcome",
          Changes: {
            channel: "sms",
            type,
            outcome: result.ok ? "sent" : result.skipped ? "skipped" : "failed",
            reason: result.reason || null,
            providerStatus: result.status || null,
            messageId: result.messageId || null,
            recipient: phone ? maskPhone(phone) : null,
          },
        },
      });
    } catch (auditError) {
      strapi.log?.warn?.("[sms] failed to persist delivery outcome", {
        type,
        orderId,
        error: (auditError as Error)?.message || String(auditError),
      });
    }
    return result;
  };

  if (!phone) {
    strapi.log?.warn?.("[sms] skipped order notification without phone", { type, orderId });
    return finish({ ok: false, skipped: true, reason: "missing_phone" });
  }

  const config = loadSmsConfig();
  if (!config.enabled) {
    strapi.log?.debug?.("[sms] skipped order notification because SMS is disabled", {
      type,
      orderId,
      recipient: maskPhone(phone),
    });
    return finish({ ok: false, skipped: true, disabled: true, reason: "disabled" });
  }

  const claimed = await claimSmsIdempotency(key);
  if (!claimed) {
    strapi.log?.info?.("[sms] skipped duplicate order notification", {
      type,
      orderId,
      recipient: maskPhone(phone),
    });
    return finish({ ok: false, skipped: true, duplicate: true, reason: "duplicate" });
  }

  const result = await sendPatternSms({
    type,
    phone,
    params: variables,
    logger: strapi.log,
    config,
  });

  if (!result.ok && !result.disabled) {
    await releaseSmsIdempotency(key);
  }

  return finish(result);
}

export async function notifyOrderCreatedSms(
  strapi: StrapiSmsLike,
  orderId: number,
): Promise<SmsSendResult> {
  const order = await loadOrderForSms(strapi, orderId);
  if (!order) return { ok: false, skipped: true, reason: "order_not_found" };

  return sendOrderSms({
    strapi,
    type: "order_created",
    order,
    variables: buildOrderNotificationParams({
      orderId,
      status: order.Status,
      amount: order?.contract?.Amount,
    }),
    fingerprint: "created",
  });
}

export async function notifyOrderStatusSms(
  strapi: StrapiSmsLike,
  params: {
    orderId: number;
    oldStatus?: string | null;
    newStatus?: string | null;
    trackingCode?: string | null;
    reason?: string | null;
  },
): Promise<SmsSendResult> {
  if (!params.newStatus || params.oldStatus === params.newStatus) {
    return { ok: false, skipped: true, reason: "unchanged_status" };
  }
  if (!isNotifiableOrderStatus(params.newStatus)) {
    return { ok: false, skipped: true, reason: "status_not_notifiable" };
  }

  const order = await loadOrderForSms(strapi, params.orderId);
  if (!order) return { ok: false, skipped: true, reason: "order_not_found" };

  const type = notificationTypeForStatus(params.newStatus);
  return sendOrderSms({
    strapi,
    type,
    order,
    variables: buildOrderNotificationParams({
      orderId: params.orderId,
      status: params.newStatus,
      amount: order?.contract?.Amount,
      trackingCode: params.trackingCode || order?.ShippingBarcode,
      reason:
        params.newStatus === "Cancelled"
          ? formatCancellationReasonForSms(params.reason)
          : params.reason,
    }),
    fingerprint: `${params.oldStatus || "none"}-${params.newStatus}-${
      params.trackingCode || order?.ShippingBarcode || "none"
    }`,
  });
}

export async function notifyShipmentTrackingSms(
  strapi: StrapiSmsLike,
  params: {
    orderId: number;
    trackingCode: string;
  },
): Promise<SmsSendResult> {
  const order = await loadOrderForSms(strapi, params.orderId);
  if (!order) return { ok: false, skipped: true, reason: "order_not_found" };

  return sendOrderSms({
    strapi,
    type: "shipped",
    order,
    variables: buildOrderNotificationParams({
      orderId: params.orderId,
      status: order?.Status || "Shipment",
      amount: order?.contract?.Amount,
      trackingCode: params.trackingCode,
    }),
    fingerprint: `tracking-${params.trackingCode}`,
  });
}
