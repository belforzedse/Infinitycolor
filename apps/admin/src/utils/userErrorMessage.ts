import { extractErrorMessage, translateErrorMessage } from "@/lib/errorTranslations";

const DEFAULT_MESSAGE = "متأسفانه مشکلی پیش آمد. لطفاً دوباره تلاش کنید.";

/**
 * What the outcome actually was, when the backend gave us no recognisable text.
 *
 * Every caller previously fell back to one generic sentence, so a denied
 * permission, an expired session, a stale record and an unreachable server all
 * read identically and none of them told the operator what to do next.
 *
 * Two rules are deliberate:
 *  - 403 does not confirm or deny that the record exists.
 *  - Nothing here promises that retrying is safe. A request that never got a
 *    response may still have been applied on the server, so the wording asks
 *    the operator to check rather than to repeat the action blindly.
 */
const STATUS_MESSAGES: Record<number, string> = {
  400: "اطلاعات ارسال‌شده معتبر نیست. مقادیر واردشده را بررسی کنید.",
  401: "نشست شما منقضی شده است. دوباره وارد شوید.",
  403: "شما به این بخش دسترسی ندارید. اگر لازم است، از مدیر سیستم دسترسی بگیرید.",
  404: "این مورد پیدا نشد. ممکن است حذف شده باشد؛ صفحه را تازه کنید.",
  409: "این مورد در این فاصله تغییر کرده است. صفحه را تازه کنید و دوباره اقدام کنید.",
  413: "حجم فایل بیش از حد مجاز است. فایل کوچک‌تری انتخاب کنید.",
  422: "اطلاعات واردشده کامل یا معتبر نیست. فیلدهای مشخص‌شده را اصلاح کنید.",
  429: "تعداد درخواست‌ها بیش از حد است. چند لحظه صبر کنید و دوباره تلاش کنید.",
};

const SERVER_ERROR = "سرویس در حال حاضر پاسخ نمی‌دهد. کمی بعد دوباره تلاش کنید.";
const NETWORK_ERROR =
  "ارتباط با سرور برقرار نشد. اتصال خود را بررسی کنید و پیش از تکرار، از ثبت‌نشدن تغییر مطمئن شوید.";

/** Reads the HTTP status off an ApiError or an axios-shaped error. */
export function extractErrorStatus(error: unknown): number | undefined {
  const candidate = error as { status?: unknown; response?: { status?: unknown } } | null;
  const status = candidate?.status ?? candidate?.response?.status;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}

/** True when the request never produced a response, so its outcome is unknown. */
function isNetworkFailure(error: unknown): boolean {
  if (extractErrorStatus(error) !== undefined) return false;
  const message = (error as { message?: unknown })?.message;
  if (typeof message !== "string") return false;
  return /network|failed to fetch|timeout|timed out|aborted|econnrefused/i.test(message);
}

/**
 * Use this for any user-visible error string (toast, inline error, notification).
 * Converts a caught error into a user-facing Persian message.
 * The raw message is preserved for logging, but only the translated string is returned to the UI.
 */
export function getUserFacingErrorMessage(error: unknown, fallback?: string): string {
  const rawMessage = extractErrorMessage(error);

  // A message the backend actually sent is the most specific thing we have.
  const translated = translateErrorMessage(rawMessage, "");
  if (translated) return translated;

  const status = extractErrorStatus(error);
  if (status !== undefined) {
    if (STATUS_MESSAGES[status]) return STATUS_MESSAGES[status];
    if (status >= 500) return SERVER_ERROR;
  }

  if (isNetworkFailure(error)) return NETWORK_ERROR;

  return fallback || DEFAULT_MESSAGE;
}
