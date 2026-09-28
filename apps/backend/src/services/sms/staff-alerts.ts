/**
 * Staff-facing order alerts.
 *
 * Separate from `notifications.ts`, which is entirely customer-addressed: these
 * go to an internal recipient list, fan out to several numbers per order, and
 * run inside the BullMQ worker rather than on the request path.
 */

import { createHash } from "node:crypto";

import { RedisClient } from "../../index";
import { getActiveStaffRecipients } from "../../api/order-alert-setting/lib/recipients";
import { getStaffPatternCode, loadSmsConfig } from "./config";
import { sendPatternSms } from "./ippanel";
import { isE2EFixturePhone } from "../../utils/e2eFixtures";
import { normalizeIranMobile, toEnglishDigits } from "./phone";
import { maskPhone } from "./redaction";
import type { SmsPatternParams, SmsSendResult, StrapiSmsLike } from "./types";

const STAFF_ORDER_STARTED: "staff_order_started" = "staff_order_started";
const TARGET_STATUS = "Started";
const SMS_MARKER_TTL_SEC = 60 * 60 * 24 * 30;
const SMS_PATTERN_PARAM_MAX_LENGTH = 40;
const UNKNOWN_PARAM = "نامشخص";

/**
 * The order was not readable yet when the worker looked. Thrown rather than
 * skipped so BullMQ retries: the job id is stable and completed jobs are
 * retained for 24h, so a completed skip here would swallow every later enqueue
 * for this order and lose the alert outright. A genuinely deleted order costs
 * three retries and then rests in the failed set.
 */
export class OrderNotReadyError extends Error {
  constructor(orderId: number, detail: string) {
    super(`Order ${orderId} not ready for a staff alert: ${detail}`);
    this.name = "OrderNotReadyError";
  }
}

export type StaffAlertRecipientOutcome = {
  recipient: string;
  outcome: "sent" | "skipped" | "failed";
  reason?: string;
  messageId?: string | number;
};

export type StaffAlertResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  sent?: number;
  recipients?: StaffAlertRecipientOutcome[];
};

type ClaimOutcome = "claimed" | "duplicate" | "unavailable";

function fingerprintPhone(phone: string): string {
  return createHash("sha256").update(phone).digest("hex").slice(0, 16);
}

/**
 * Unlike `claimSmsIdempotency`, this separates "the marker already exists" from
 * "Redis did not answer". The shared helper collapses both into `false`, which
 * a fan-out sender would read as a duplicate — turning a Redis hiccup into a
 * silently dropped alert that logs as if it were deduped.
 */
async function claimStaffMarker(key: string): Promise<ClaimOutcome> {
  try {
    const client = await RedisClient;
    const result = await client.set(key, "1", { NX: true, EX: SMS_MARKER_TTL_SEC });
    return result === "OK" ? "claimed" : "duplicate";
  } catch {
    return "unavailable";
  }
}

async function releaseStaffMarker(key: string): Promise<void> {
  try {
    const client = await RedisClient;
    await client.del(key);
  } catch {
    /* best-effort */
  }
}

function trimSmsParam(value?: string | number | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > SMS_PATTERN_PARAM_MAX_LENGTH
    ? normalized.slice(0, SMS_PATTERN_PARAM_MAX_LENGTH)
    : normalized;
}

/**
 * A human name only. `user.username` is deliberately not a fallback: OTP signup
 * stores the phone number there (`api/auth/services/credential-flow.ts`), so it
 * would put a phone number under the pattern's «مشتری» label.
 */
function extractCustomerName(order: any): string | undefined {
  const info = order?.user?.user_info;
  const candidate =
    order?.delivery_address?.FullName ||
    [info?.FirstName, info?.LastName].filter(Boolean).join(" ");
  return trimSmsParam(candidate);
}

/**
 * The number staff would call about this order, in the local `09…` form people
 * actually dial rather than the stored `+98…` E.164 form. Falls back to the
 * account phone, and keeps an unrecognised-but-dialable number (a landline,
 * which `normalizeIranMobile` rejects) instead of discarding it.
 */
function extractCustomerPhone(order: any): string | undefined {
  const candidates = [order?.delivery_address?.Phone, order?.user?.phone];
  for (const candidate of candidates) {
    const mobile = normalizeIranMobile(candidate);
    if (mobile) return `0${mobile.slice(3)}`;
    const digits = toEnglishDigits(String(candidate || "")).replace(/[\s().-]/g, "");
    if (/^\d{7,15}$/.test(digits)) return digits;
  }
  return undefined;
}

/** Latin digits with thousands separators; no ICU dependency in the container. */
function formatAmount(value: unknown): string | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return String(Math.round(numeric)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Every key here is always present. `sanitizePatternParams` drops undefined
 * values, and a pattern variable declared at IPPanel but not supplied leaves a
 * hole in the delivered message — so an order with no address name or no
 * contract must still fill every slot.
 *
 * `contract.Amount` is the only settled total on an order (the schema has no
 * `Total` column) and is denominated in تومان.
 */
function buildStaffParams(order: any): SmsPatternParams {
  return {
    orderId: order.id,
    amount: formatAmount(order?.contract?.Amount) ?? UNKNOWN_PARAM,
    customer: extractCustomerName(order) ?? UNKNOWN_PARAM,
    phone: extractCustomerPhone(order) ?? UNKNOWN_PARAM,
  };
}

async function recordOutcome(
  strapi: StrapiSmsLike,
  orderId: number,
  outcomes: StaffAlertRecipientOutcome[],
  summary: { reason?: string; sent: number },
): Promise<void> {
  try {
    await strapi.db?.query?.("api::order-log.order-log")?.create?.({
      data: {
        order: Number(orderId),
        Action: "Update",
        Description: "Staff order alert SMS delivery outcome",
        Changes: {
          channel: "sms",
          type: STAFF_ORDER_STARTED,
          sent: summary.sent,
          reason: summary.reason || null,
          recipients: outcomes,
        },
      },
    });
  } catch (auditError) {
    strapi.log?.warn?.("[sms] failed to persist staff alert outcome", {
      orderId,
      error: (auditError as Error)?.message || String(auditError),
    });
  }
}

async function loadOrderForStaffAlert(strapi: StrapiSmsLike, orderId: number): Promise<any> {
  if (!strapi.entityService?.findOne) return null;
  return strapi.entityService.findOne("api::order.order", orderId, {
    populate: {
      user: { populate: { user_info: true } },
      delivery_address: true,
      contract: true,
    },
  });
}

/**
 * Notify the staff recipient list that an order has entered «در حال انجام».
 *
 * Runs in the BullMQ worker. Re-reads the order because the enqueue happens
 * inside the settlement transaction's lifecycle hook, which may still roll back.
 */
export async function notifyStaffOrderStartedSms(
  strapi: StrapiSmsLike,
  params: { orderId: number },
): Promise<StaffAlertResult> {
  const { orderId } = params;
  const order = await loadOrderForStaffAlert(strapi, orderId);
  if (!order) {
    // Not necessarily gone: a manual admin order is enqueued from `afterCreate`,
    // inside the transaction that inserts it.
    throw new OrderNotReadyError(orderId, "not found");
  }

  if (order.Status === "Paying") {
    throw new OrderNotReadyError(orderId, "still Paying");
  }
  if (order.Status !== TARGET_STATUS) {
    // The order moved on (or the settlement rolled back). Nothing to announce.
    return { ok: false, skipped: true, reason: "status_not_started" };
  }

  // A staging E2E purchase is not an order staff should be paged about.
  if (isE2EFixturePhone(order?.user?.phone)) {
    await recordOutcome(strapi, orderId, [], { reason: "e2e_fixture", sent: 0 });
    return { ok: false, skipped: true, reason: "e2e_fixture" };
  }

  const recipients = await getActiveStaffRecipients(strapi);
  if (recipients.length === 0) {
    return { ok: false, skipped: true, reason: "no_recipients" };
  }

  const config = loadSmsConfig();
  if (!config.enabled) {
    strapi.log?.debug?.("[sms] skipped staff order alert because SMS is disabled", { orderId });
    await recordOutcome(strapi, orderId, [], { reason: "disabled", sent: 0 });
    return { ok: false, skipped: true, reason: "disabled" };
  }

  const patternCode = getStaffPatternCode(config, STAFF_ORDER_STARTED);
  if (!patternCode) {
    strapi.log?.error?.("[sms] staff order alert has no pattern code", {
      orderId,
      envVar: "IP_PANEL_PATTERN_STAFF_ORDER_STARTED",
    });
    await recordOutcome(strapi, orderId, [], { reason: "missing_config", sent: 0 });
    return { ok: false, skipped: true, reason: "missing_config" };
  }

  const variables = buildStaffParams(order);
  const outcomes: StaffAlertRecipientOutcome[] = [];
  let sent = 0;

  for (const recipient of recipients) {
    const masked = maskPhone(recipient.phone);
    const key = `sms:staff-order-alert:${STAFF_ORDER_STARTED}:${orderId}:${fingerprintPhone(
      recipient.phone,
    )}`;
    const claim = await claimStaffMarker(key);

    if (claim === "duplicate") {
      outcomes.push({ recipient: masked, outcome: "skipped", reason: "duplicate" });
      continue;
    }
    if (claim === "unavailable") {
      // Send anyway. A rare duplicate SMS is a smaller failure than an alert
      // that never arrives because the dedupe store was briefly unreachable.
      strapi.log?.warn?.("[sms] staff alert idempotency store unavailable; sending anyway", {
        orderId,
        recipient: masked,
      });
    }

    let result: SmsSendResult;
    try {
      result = await sendPatternSms({
        type: STAFF_ORDER_STARTED,
        phone: recipient.phone,
        patternCode,
        params: variables,
        logger: strapi.log,
        config,
      });
    } catch (error) {
      // `sendPatternSms` is documented not to throw, but one recipient must
      // never be able to abort the fan-out.
      result = { ok: false, reason: (error as Error)?.message || "request_failed" };
    }

    if (result.ok) {
      sent += 1;
      outcomes.push({
        recipient: masked,
        outcome: "sent",
        messageId: result.messageId,
      });
      continue;
    }

    if (claim === "claimed" && !result.disabled) {
      await releaseStaffMarker(key);
    }
    outcomes.push({
      recipient: masked,
      outcome: result.skipped ? "skipped" : "failed",
      reason: result.reason || "unknown",
    });
  }

  await recordOutcome(strapi, orderId, outcomes, { sent });

  strapi.log?.info?.("[sms] staff order alert processed", {
    orderId,
    recipients: recipients.length,
    sent,
  });

  return { ok: sent > 0, sent, recipients: outcomes };
}
