import { normalizePhoneForAnipo } from "../../../shipping/services/anipo";

type AnipoOrderAddress = {
  FullName?: string | null;
  Phone?: string | null;
  phone?: string | null;
  PostalCode?: string | null;
  FullAddress?: string | null;
  shipping_city?: {
    Title?: string | null;
    shipping_province?: { Title?: string | null } | null;
  } | null;
} | null;

type AnipoOrderUser = {
  phone?: string | null;
  Phone?: string | null;
  username?: string | null;
  user_info?: {
    FirstName?: string | null;
    LastName?: string | null;
  } | null;
} | null;

export type AnipoOrderRecipientSource = {
  delivery_address?: AnipoOrderAddress;
  user?: AnipoOrderUser;
};

function cleanText(value: unknown): string {
  return String(value ?? "").normalize("NFC").trim();
}

/** Preserve provider-visible spacing while normalizing common Persian variants. */
export function normalizeAnipoLocationName(value: unknown): string {
  return cleanText(value)
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\s+/g, " ");
}

export function normalizeAnipoPostalCode(value: unknown): string | undefined {
  const digits = cleanText(value)
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/\D/g, "");
  return /^\d{10}$/.test(digits) && digits !== "0000000000"
    ? digits
    : undefined;
}

export function buildAnipoOrderRecipient(order: AnipoOrderRecipientSource) {
  const address = order?.delivery_address;
  const user = order?.user;
  const profileName = [
    cleanText(user?.user_info?.FirstName),
    cleanText(user?.user_info?.LastName),
  ]
    .filter(Boolean)
    .join(" ");

  return {
    receiverName:
      cleanText(address?.FullName) ||
      profileName ||
      cleanText(user?.username) ||
      "کاربر",
    provinceName: normalizeAnipoLocationName(
      address?.shipping_city?.shipping_province?.Title,
    ),
    cityName: normalizeAnipoLocationName(address?.shipping_city?.Title),
    mobile: normalizePhoneForAnipo(
      cleanText(address?.Phone) ||
        cleanText(address?.phone) ||
        cleanText(user?.phone) ||
        cleanText(user?.Phone),
    ),
    fullAddress: cleanText(address?.FullAddress),
    postalCode: normalizeAnipoPostalCode(address?.PostalCode),
  };
}
