import type { OrderLifecycleStatus } from "@/services/super-admin/orders/adjustItems";
import { translateOrderStatus } from "@/utils/statusTranslations";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";

/**
 * Order fulfilment is a strict chain, not a free choice of status.
 *
 * Mirrors `NEXT_STATUS` in
 * `apps/backend/src/api/order/controllers/helpers/adminTransition.ts`. The
 * server is authoritative — this copy exists so the admin can say *which*
 * statuses are reachable before sending a request that can only be refused, and
 * so a bulk action can skip the orders it would fail on rather than firing a
 * request per order and reporting one generic failure.
 *
 * Keep the two in sync. Marking a Started order Done advances it to Shipment
 * in the same backend transaction. Older Done orders may still use Shipment.
 * Nothing transitions *to* `Started`: an order arrives there
 * by being paid for, which is why offering it as a bulk action never worked.
 */
export const ORDER_NEXT_STATUSES: Partial<
  Record<OrderLifecycleStatus, readonly OrderLifecycleStatus[]>
> = {
  Started: ["Done"],
  Done: ["Shipment"],
};

export function canTransitionOrder(
  from: string | undefined,
  to: OrderLifecycleStatus,
): boolean {
  if (!from) return false;
  if (from === to) return true; // The server treats this as a no-op, not an error.
  const allowed = ORDER_NEXT_STATUSES[from as OrderLifecycleStatus];
  return Boolean(allowed?.includes(to));
}

/** Why this particular order cannot move to `to`, in Persian, or null if it can. */
export function orderTransitionBlockReason(
  from: string | undefined,
  to: OrderLifecycleStatus,
): string | null {
  if (canTransitionOrder(from, to)) return null;
  if (!from) return "وضعیت سفارش مشخص نیست";

  const allowed = ORDER_NEXT_STATUSES[from as OrderLifecycleStatus];
  const fromLabel = translateOrderStatus(from as OrderLifecycleStatus);
  if (!allowed || allowed.length === 0) {
    return `از وضعیت «${fromLabel}» تغییر دیگری ممکن نیست`;
  }
  const allowedLabels = allowed
    .map((status) => `«${translateOrderStatus(status)}»`)
    .join(" یا ");
  return `از «${fromLabel}» فقط می‌توان به ${allowedLabels} رفت`;
}

type TransitionErrorPayload = {
  fromStatus?: string;
  requestedStatus?: string;
  allowedStatuses?: string[];
  error?: string;
};

/**
 * Turns a failed transition into something an operator can act on.
 *
 * The backend already returns a precise 409 — `INVALID_ORDER_TRANSITION` with
 * `fromStatus`/`allowedStatuses`, or `RESERVE_HOLD_ACTIVE` — and both the bulk
 * and single-order paths used to discard all of it in favour of one fixed
 * sentence, which is why an impossible transition was indistinguishable from a
 * network failure.
 */
export function describeOrderTransitionError(error: unknown): string {
  const apiError = error as {
    errorCode?: string;
    data?: TransitionErrorPayload;
    message?: string;
  };
  const payload = apiError?.data;
  const errorCode =
    apiError?.errorCode ||
    (typeof payload?.error === "string" ? payload.error : undefined);

  if (apiError?.errorCode === "INVALID_ORDER_TRANSITION") {
    const fromLabel = payload?.fromStatus
      ? translateOrderStatus(payload.fromStatus as OrderLifecycleStatus)
      : null;
    const allowed = (payload?.allowedStatuses ?? [])
      .map((status) => `«${translateOrderStatus(status as OrderLifecycleStatus)}»`)
      .join(" یا ");

    if (fromLabel && allowed) {
      return `این تغییر وضعیت مجاز نیست. از «${fromLabel}» فقط می‌توان به ${allowed} رفت.`;
    }
    if (fromLabel) {
      return `از وضعیت «${fromLabel}» این تغییر ممکن نیست.`;
    }
    return "این تغییر وضعیت طبق ترتیب مراحل سفارش مجاز نیست.";
  }

  if (apiError?.errorCode === "RESERVE_HOLD_ACTIVE") {
    return "سفارش در مهلت رزرو ۴۸ ساعته است و هنوز قابل تکمیل و ارسال نیست.";
  }

  if (
    errorCode === "ORDER_CANCEL_INVALID_STATUS" ||
    errorCode === "invalid_status"
  ) {
    const fromLabel = payload?.fromStatus
      ? translateOrderStatus(payload.fromStatus as OrderLifecycleStatus)
      : null;
    if (fromLabel) {
      return `لغو از وضعیت «${fromLabel}» مجاز نیست. سفارش‌های مرجوع‌شده را از مسیر مرجوعی پیگیری کنید.`;
    }
    return "لغو این سفارش در وضعیت فعلی مجاز نیست. سفارش‌های مرجوع‌شده را از مسیر مرجوعی پیگیری کنید.";
  }

  if (errorCode === "SNAPPAY_OPERATOR_REASON_REQUIRED") {
    return "برای لغو سفارش اسنپ‌پی دلیل لغو را وارد کنید.";
  }

  if (errorCode === "SNAPPAY_OPERATOR_STATE_INVALID") {
    return "وضعیت پرداخت اسنپ‌پی برای لغو مناسب نیست. وضعیت سفارش و پرداخت را بررسی کنید.";
  }

  if (errorCode === "SNAPPAY_OPERATOR_OPERATION_ACTIVE") {
    return "یک عملیات قبلی روی این سفارش اسنپ‌پی هنوز در حال انجام است؛ درخواست را تکرار نکنید.";
  }

  if (errorCode === "SNAPPAY_ATTEMPT_NOT_FOUND") {
    return "تراکنش اسنپ‌پی این سفارش پیدا نشد؛ موضوع را دستی بررسی کنید.";
  }

  if (
    typeof errorCode === "string" &&
    errorCode.startsWith("SNAPPAY_") &&
    /CANCEL|STATUS|UPDATE|SETTLE|VERIFY/.test(errorCode)
  ) {
    return "هم‌زمان‌سازی با اسنپ‌پی انجام نشد. نتیجه را دستی بررسی کنید و درخواست را تکرار نکنید.";
  }

  return getUserFacingErrorMessage(error, "تغییر وضعیت سفارش انجام نشد");
}
