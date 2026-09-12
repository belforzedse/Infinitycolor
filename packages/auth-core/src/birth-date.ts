export type JalaliDateParts = {
  birthYear: string;
  birthMonth: string;
  birthDay: string;
};

const PERSIAN_CALENDAR_LOCALE = "en-US-u-ca-persian";
const EMPTY_PARTS: JalaliDateParts = {
  birthYear: "",
  birthMonth: "",
  birthDay: "",
};

export const normalizeDigits = (value: string) =>
  value
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));

const pad = (value: number | string, length: number) =>
  String(value).padStart(length, "0");

const isValidDate = (date: Date) => !Number.isNaN(date.getTime());

const isLikelyJalaliYear = (year: number) => year >= 1200 && year <= 1600;

const extractNumericParts = (
  value?: string | null,
): [number, number, number] | null => {
  if (!value) return null;
  const parts = normalizeDigits(String(value))
    .split(/[^\d]/)
    .filter(Boolean)
    .map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part)))
    return null;

  if (String(parts[0]).length === 4) return [parts[0], parts[1], parts[2]];
  if (String(parts[2]).length === 4) return [parts[2], parts[1], parts[0]];
  return null;
};

const parseGregorianDateString = (value: string): Date | null => {
  const parts = extractNumericParts(value);
  if (!parts) return null;
  const [year, month, day] = parts;
  if (month < 1 || month > 12 || day < 1) return null;

  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (!isValidDate(date)) return null;
  // `Date.UTC` rolls an overflowing day forward (2025-02-31 becomes 2025-03-03), so a
  // literal `day > 31` never rejected a day the month does not actually have. The
  // round-trip does.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
};

const dateToGregorianString = (date: Date): string | null => {
  if (!isValidDate(date)) return null;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
};

export const formatGregorianDateToJalaliParts = (
  date: Date,
): JalaliDateParts => {
  if (!isValidDate(date)) return EMPTY_PARTS;

  const parts = new Intl.DateTimeFormat(PERSIAN_CALENDAR_LOCALE, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  }).formatToParts(date);

  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);

  if (!year || !month || !day) return EMPTY_PARTS;
  return {
    birthYear: pad(year, 4),
    birthMonth: pad(month, 2),
    birthDay: pad(day, 2),
  };
};

export const parseStoredBirthDateToJalaliParts = (
  value?: string | null,
): JalaliDateParts => {
  const parts = extractNumericParts(value);
  if (!parts) return EMPTY_PARTS;

  const [year, month, day] = parts;
  if (isLikelyJalaliYear(year)) {
    return {
      birthYear: pad(year, 4),
      birthMonth: pad(month, 2),
      birthDay: pad(day, 2),
    };
  }

  const date = parseGregorianDateString(String(value));
  return date ? formatGregorianDateToJalaliParts(date) : EMPTY_PARTS;
};

/**
 * Shared copy and bounds for the year/month/day birth-date fields.
 *
 * The storefront account form, the storefront registration form and the central auth
 * registration form all render the same three inputs; keeping the hints and limits here
 * is what stops them drifting apart (they previously disagreed on both the placeholder
 * text and the maximum year).
 */
export const BIRTH_DATE_PLACEHOLDERS = {
  year: "سال (مثلا 1370)",
  month: "ماه (1-12)",
  day: "روز (1-31)",
} as const;

export const BIRTH_DATE_YEAR_MIN = 1300;

/** Current Jalali year, so the year field cannot offer a date in the future. */
export const currentJalaliYear = (): number =>
  Number(formatGregorianDateToJalaliParts(new Date()).birthYear) || BIRTH_DATE_YEAR_MIN;

/**
 * Keep only digits, accepting Persian and Arabic ones. The fields cannot be
 * `type="number"`: browsers reject `۱۳۷۰` outright there, so the value silently reads
 * back empty and the shopper cannot tell why.
 */
export const normalizeBirthDatePart = (value: string, maxLength: number): string =>
  normalizeDigits(value).replace(/\D/g, "").slice(0, maxLength);

/** Stored parts are zero-padded; `08` in an input reads as a bug, so show `8`. */
export const unpadBirthDatePart = (value: string): string =>
  value.replace(/^0+(?=\d)/, "");

/**
 * Gregorian instant of 1 Farvardin for a Jalali year, or null when the year is outside
 * the range the Persian calendar formatter handles.
 *
 * Nowruz always lands on 19-22 March of `jy + 621`, so four probes settle it without a
 * day-by-day scan.
 */
const nowruzUtcMs = (jy: number): number | null => {
  const gy = jy + 621;
  for (let day = 19; day <= 22; day += 1) {
    const ms = Date.UTC(gy, 2, day, 12);
    const parts = formatGregorianDateToJalaliParts(new Date(ms));
    if (
      Number(parts.birthYear) === jy &&
      Number(parts.birthMonth) === 1 &&
      Number(parts.birthDay) === 1
    ) {
      return ms;
    }
  }
  return null;
};

/**
 * A Jalali year is leap when it runs 366 days, which is exactly when Esfand has 30 days.
 * Derived from the same Persian calendar formatter the conversion uses, so validation and
 * conversion cannot disagree about which dates exist.
 */
export const isJalaliLeapYear = (year: string | number): boolean => {
  const jy = Number(normalizeDigits(String(year)));
  if (!Number.isFinite(jy)) return false;
  const start = nowruzUtcMs(jy);
  const next = nowruzUtcMs(jy + 1);
  if (start === null || next === null) return false;
  return Math.round((next - start) / 86_400_000) === 366;
};

/**
 * Days in a Jalali month, or 0 for a month outside 1-12.
 *
 * Farvardin-Shahrivar are fixed at 31 days and Mehr-Bahman at 30 by the definition of the
 * Solar Hijri calendar; only Esfand varies, and that one is resolved against the
 * formatter. Use this instead of a literal 31: months 7-12 never have a 31st, so
 * `1388/08/31` is not a real date even though it passes a naive bound.
 */
export const jalaliMonthLength = (
  year: string | number,
  month: string | number,
): number => {
  const jy = Number(normalizeDigits(String(year)));
  const jm = Number(normalizeDigits(String(month)));
  if (!Number.isFinite(jy) || !Number.isFinite(jm) || jm < 1 || jm > 12) return 0;
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isJalaliLeapYear(jy) ? 30 : 29;
};

export const jalaliBirthDateToGregorianDate = (
  year: string | number,
  month: string | number,
  day: string | number,
): string | null => {
  const jy = Number(normalizeDigits(String(year)));
  const jm = Number(normalizeDigits(String(month)));
  const jd = Number(normalizeDigits(String(day)));
  if (!jy || !jm || !jd || jm < 1 || jm > 12 || jd < 1) return null;
  if (jd > jalaliMonthLength(jy, jm)) return null;

  const candidateYear = jy + 621;
  const start = Date.UTC(candidateYear - 1, 0, 1, 12);
  const end = Date.UTC(candidateYear + 1, 11, 31, 12);

  for (let cursor = start; cursor <= end; cursor += 24 * 60 * 60 * 1000) {
    const date = new Date(cursor);
    const parts = formatGregorianDateToJalaliParts(date);
    if (
      Number(parts.birthYear) === jy &&
      Number(parts.birthMonth) === jm &&
      Number(parts.birthDay) === jd
    ) {
      return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-${pad(
        date.getUTCDate(),
        2,
      )}`;
    }
  }

  return null;
};

export const parseStoredBirthDateToDate = (
  value?: string | null,
  fallback: Date = new Date(),
): Date => {
  const parts = extractNumericParts(value);
  if (!parts) return fallback;

  const [year, month, day] = parts;
  const normalized = isLikelyJalaliYear(year)
    ? jalaliBirthDateToGregorianDate(year, month, day)
    : `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
  if (!normalized) return fallback;

  return parseGregorianDateString(normalized) ?? fallback;
};

export const formatBirthDateValueForStorage = (
  value: unknown,
): string | undefined => {
  if (!value) return undefined;

  if (value instanceof Date) {
    return dateToGregorianString(value) ?? undefined;
  }

  if (typeof value === "object" && value !== null && "value" in value) {
    return formatBirthDateValueForStorage((value as { value?: unknown }).value);
  }

  if (typeof value === "string") {
    const parts = extractNumericParts(value);
    if (!parts) return undefined;
    const [year, month, day] = parts;
    if (isLikelyJalaliYear(year)) {
      return jalaliBirthDateToGregorianDate(year, month, day) ?? undefined;
    }
    return parseGregorianDateString(value)
      ? `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
      : undefined;
  }

  return undefined;
};
