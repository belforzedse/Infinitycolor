/**
 * Single source of truth for payment gateway display: canonical key, Persian label,
 * and icon asset. Used by PaymentGatewayBadge and translatePaymentGateway so labels/icons
 * are never duplicated across components.
 *
 * Note: this is display-only. Backend gateway Codes/Titles are unchanged.
 */

export type PaymentGatewayKey =
  | "zarinpal"
  | "mellat"
  | "snappay"
  | "samankish"
  | "wallet";

export interface PaymentGatewayMeta {
  key: PaymentGatewayKey;
  label: string;
  /** Path under /public. Render with a plain <img> (icons include SVGs). */
  icon: string;
}

export const PAYMENT_GATEWAYS: Record<PaymentGatewayKey, PaymentGatewayMeta> = {
  zarinpal: { key: "zarinpal", label: "زرین پال", icon: "/images/cart/zarinpal.svg" },
  mellat: { key: "mellat", label: "بانک ملت", icon: "/images/cart/melat.png" },
  snappay: { key: "snappay", label: "اسنپ! پی", icon: "/images/cart/snappay.svg" },
  samankish: { key: "samankish", label: "سامان کیش", icon: "/images/cart/samankish.png" },
  wallet: { key: "wallet", label: "کیف پول", icon: "/images/cart/wallet.svg" },
};

const normalize = (value?: string | null): string =>
  (value ?? "").toString().trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");

/**
 * Normalize an arbitrary gateway value (backend Code/Title, English or Persian) to its meta.
 * Returns null for empty/unknown values so callers can fall back gracefully.
 */
export const resolvePaymentGateway = (value?: string | null): PaymentGatewayMeta | null => {
  const n = normalize(value);
  if (!n) return null;

  if (n.includes("snapp") || n.includes("اسنپ")) return PAYMENT_GATEWAYS.snappay;
  if (n.includes("zarin") || n.includes("زرین")) return PAYMENT_GATEWAYS.zarinpal;
  if (n.includes("saman") || n.includes("سامان")) return PAYMENT_GATEWAYS.samankish;
  if (n.includes("mellat") || n.includes("ملت") || n.includes("beh pardakht"))
    return PAYMENT_GATEWAYS.mellat;
  if (n.includes("wallet") || n.includes("کیف")) return PAYMENT_GATEWAYS.wallet;

  return null;
};

/** Persian label for a gateway, falling back to the raw value (or «نامشخص») when unknown. */
export const getPaymentGatewayLabel = (value?: string | null): string => {
  const meta = resolvePaymentGateway(value);
  if (meta) return meta.label;
  const raw = (value ?? "").toString().trim();
  return raw || "نامشخص";
};
