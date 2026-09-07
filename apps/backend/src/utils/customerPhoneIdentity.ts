import { createHash } from "node:crypto";

/** Persian and Arabic numerals folded to ASCII, keeping only digits and `+`. */
export function normalizeCustomerPhoneDigits(value: unknown): string {
  return String(value ?? "")
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[^\d+]/g, "");
}

export function canonicalCustomerPhone(value: unknown): string | null {
  let phone = normalizeCustomerPhoneDigits(value);
  if (phone.startsWith("0098")) phone = `+98${phone.slice(4)}`;
  else if (phone.startsWith("98")) phone = `+${phone}`;
  else if (phone.startsWith("09")) phone = `+98${phone.slice(1)}`;
  else if (phone.startsWith("9")) phone = `+98${phone}`;
  return /^\+989\d{9}$/.test(phone) ? phone : null;
}

export function customerPhoneStorageVariants(value: unknown): [string, string] {
  const phone = canonicalCustomerPhone(value);
  if (!phone) throw new Error("CUSTOMER_PHONE_INVALID");
  return [phone, `0${phone.slice(3)}`];
}

export function customerPhoneAdvisoryKey(value: unknown): string {
  const phone = canonicalCustomerPhone(value);
  if (!phone) throw new Error("CUSTOMER_PHONE_INVALID");
  return createHash("sha256").update(phone, "utf8").digest().readBigInt64BE(0).toString();
}
