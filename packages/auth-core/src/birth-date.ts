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

const normalizeDigits = (value: string) =>
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
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return isValidDate(date) ? date : null;
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

export const jalaliBirthDateToGregorianDate = (
  year: string | number,
  month: string | number,
  day: string | number,
): string | null => {
  const jy = Number(normalizeDigits(String(year)));
  const jm = Number(normalizeDigits(String(month)));
  const jd = Number(normalizeDigits(String(day)));
  if (!jy || !jm || !jd || jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;

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
