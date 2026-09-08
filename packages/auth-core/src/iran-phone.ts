/** Fold Persian and Arabic numerals to ASCII while keeping only digits and `+`. */
export function normalizeIranPhoneDigits(value: unknown): string {
  return String(value ?? "")
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[^\d+]/g, "");
}

/** Return the canonical Iranian mobile representation (`+989xxxxxxxxx`). */
export function canonicalIranPhone(value: unknown): string | null {
  let phone = normalizeIranPhoneDigits(value);
  if (phone.startsWith("0098")) phone = `+98${phone.slice(4)}`;
  else if (phone.startsWith("98")) phone = `+${phone}`;
  else if (phone.startsWith("09")) phone = `+98${phone.slice(1)}`;
  else if (phone.startsWith("9")) phone = `+98${phone}`;
  return /^\+989\d{9}$/.test(phone) ? phone : null;
}
