import { createHash } from "node:crypto";
import { canonicalIranPhone, normalizeIranPhoneDigits } from "@repo/auth-core";

export const normalizeCustomerPhoneDigits = normalizeIranPhoneDigits;
export const canonicalCustomerPhone = canonicalIranPhone;

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
