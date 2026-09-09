import { faNum } from "./faNum";

/**
 * Time helpers for the 48h combined-shipping window.
 *
 * The deadline is always a server timestamp; the countdown is display-only. Two
 * different countdown implementations used to exist (utils/formatCountdown and a
 * local copy inside ReserveInfoCard) and neither produced Persian digits.
 */

const PERSIAN_LOCALE = "fa-IR-u-ca-persian";

export type ReserveRemaining = {
  totalMs: number;
  hours: number;
  minutes: number;
  isExpired: boolean;
};

export function reserveRemaining(
  expiresAt?: string | null,
  now: number = Date.now(),
): ReserveRemaining {
  if (!expiresAt) return { totalMs: 0, hours: 0, minutes: 0, isExpired: true };
  const end = new Date(expiresAt).getTime();
  if (Number.isNaN(end)) return { totalMs: 0, hours: 0, minutes: 0, isExpired: true };

  const totalMs = Math.max(0, end - now);
  return {
    totalMs,
    hours: Math.floor(totalMs / 3_600_000),
    minutes: Math.floor((totalMs % 3_600_000) / 60_000),
    isExpired: totalMs <= 0,
  };
}

/** Long form for headings: «۲۳ ساعت و ۴۰ دقیقه باقی مانده». */
export function formatReserveRemaining(
  expiresAt?: string | null,
  now: number = Date.now(),
): string {
  const { hours, minutes, isExpired } = reserveRemaining(expiresAt, now);
  if (isExpired) return "مهلت به پایان رسیده است";
  if (hours <= 0) return `${faNum(minutes)} دقیقه باقی مانده`;
  return `${faNum(hours)} ساعت و ${faNum(minutes)} دقیقه باقی مانده`;
}

/** Compact form for chips and table cells: «۲۳س ۴۰د». */
export function formatReserveCountdown(
  expiresAt?: string | null,
  now: number = Date.now(),
): string {
  const { hours, minutes, isExpired } = reserveRemaining(expiresAt, now);
  if (isExpired) return "پایان یافته";
  return `${faNum(hours)}س ${faNum(minutes)}د`;
}

/**
 * The absolute deadline: «پنجشنبه ۲۰ شهریور، ساعت ۱۴:۳۰».
 *
 * Deliberately labelled as the deadline for *adding orders*, never as a delivery
 * estimate -- the system knows when the hold ends, not when the courier arrives.
 */
export function formatReserveDeadline(expiresAt?: string | null): string {
  if (!expiresAt) return "-";
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "-";

  const dayText = new Intl.DateTimeFormat(PERSIAN_LOCALE, {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
  const timeText = new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);

  return `${dayText}، ساعت ${timeText}`;
}

/** Persian label for a group's lifecycle state. */
export function reserveStateLabel(
  state?: string | null,
  closureReason?: string | null,
): string {
  switch (state) {
    case "PendingActivation":
      return "در انتظار پرداخت";
    case "Active":
      return "رزرو فعال";
    case "ReadyToFulfill":
      return closureReason === "ReleasedEarly"
        ? "آماده ارسال (آزادسازی زودهنگام)"
        : "مهلت رزرو پایان یافته / آماده ارسال";
    case "Fulfilling":
      return "در حال آماده‌سازی";
    case "Completed":
      return "ارسال شده";
    case "Cancelled":
      return "لغو شده";
    default:
      return "نامشخص";
  }
}
