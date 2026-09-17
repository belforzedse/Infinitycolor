/**
 * Convert Persian (۰-۹, U+06F0–U+06F9) and Arabic-Indic (٠-٩, U+0660–U+0669)
 * digits to ASCII. Useful before parsing user input that may contain localized
 * digits (e.g. a price field whose displayed value is fa-IR formatted).
 */
export function normalizeDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (ch) => {
    const code = ch.charCodeAt(0);
    const base = code >= 0x0660 && code <= 0x0669 ? 0x0660 : 0x06f0;
    return String(code - base);
  });
}

const ASCII_TO_PERSIAN_DIGITS: Readonly<Record<string, string>> = {
  "0": "۰",
  "1": "۱",
  "2": "۲",
  "3": "۳",
  "4": "۴",
  "5": "۵",
  "6": "۶",
  "7": "۷",
  "8": "۸",
  "9": "۹",
};

const FA_IR_NUMBERING = "arabext" as const;
const TEHRAN_TIME_ZONE = "Asia/Tehran";

function pinPersianDigits(value: string): string {
  return value.replace(/[0-9]/g, (digit) => ASCII_TO_PERSIAN_DIGITS[digit] ?? digit);
}

/**
 * Format a number with Persian digits and grouping that match across Node SSR
 * and browser ICUs. `numberingSystem` is pinned so a WebView whose default
 * `fa-IR` still emits Latin digits hydrates against the same text.
 */
export function faNum(n: number | string, opts?: Intl.NumberFormatOptions) {
  const num = typeof n === "string" ? Number(n) : n;
  if (typeof num === "number" && !Number.isNaN(num)) {
    try {
      return pinPersianDigits(
        num.toLocaleString("fa-IR", {
          ...opts,
          numberingSystem: FA_IR_NUMBERING,
        }),
      );
    } catch {
      return pinPersianDigits(String(num));
    }
  }
  return String(n);
}

/**
 * Calendar date in Asia/Tehran so SSR (typically UTC) and client first paint
 * show the same Jalali day. Used on storefront blog surfaces that hydrate.
 */
export function formatFaDate(
  value: Date | string | null | undefined,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (value == null || value === "") return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  try {
    return pinPersianDigits(
      date.toLocaleDateString("fa-IR", {
        ...options,
        timeZone: TEHRAN_TIME_ZONE,
        numberingSystem: FA_IR_NUMBERING,
      }),
    );
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
