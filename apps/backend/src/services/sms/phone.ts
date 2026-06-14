const PERSIAN_ZERO = "۰".charCodeAt(0);
const ARABIC_ZERO = "٠".charCodeAt(0);

export function toEnglishDigits(value: string): string {
  return String(value || "").replace(/[۰-۹٠-٩]/g, (char) => {
    const code = char.charCodeAt(0);
    if (code >= PERSIAN_ZERO && code <= PERSIAN_ZERO + 9) {
      return String(code - PERSIAN_ZERO);
    }
    return String(code - ARABIC_ZERO);
  });
}

export function normalizeIranMobile(rawPhone?: string | null): string | null {
  const raw = toEnglishDigits(String(rawPhone || "")).trim();
  if (!raw) return null;

  const cleaned = raw.replace(/[\s().-]/g, "");
  if (!/^\+?\d+$/.test(cleaned)) return null;

  let digits = cleaned;
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("0098")) digits = `98${digits.slice(4)}`;
  if (digits.startsWith("0")) digits = `98${digits.slice(1)}`;
  if (!digits.startsWith("98") && /^9\d{9}$/.test(digits)) {
    digits = `98${digits}`;
  }

  if (!/^989\d{9}$/.test(digits)) return null;
  return `+${digits}`;
}
