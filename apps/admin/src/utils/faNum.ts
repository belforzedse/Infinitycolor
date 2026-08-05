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

export function faNum(n: number | string, opts?: Intl.NumberFormatOptions) {
  const num = typeof n === "string" ? Number(n) : n;
  if (typeof num === "number" && !Number.isNaN(num)) {
    try {
      return num.toLocaleString("fa-IR", opts);
    } catch {
      return String(num);
    }
  }
  return String(n);
}
