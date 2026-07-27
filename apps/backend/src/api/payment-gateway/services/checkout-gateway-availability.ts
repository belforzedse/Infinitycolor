import { Strapi } from "@strapi/strapi";

export type CheckoutGatewayCode =
  | "samankish"
  | "mellat"
  | "snappay"
  | "wallet"
  | "zarinpal";

export type CheckoutGatewayItem = {
  code: CheckoutGatewayCode;
  title: string;
};

export const SUPPORTED_CHECKOUT_GATEWAYS: readonly CheckoutGatewayItem[] = [
  { code: "samankish", title: "سامان‌کیش" },
  { code: "mellat", title: "بانک ملت" },
  { code: "zarinpal", title: "زرین‌پال" },
  { code: "snappay", title: "پرداخت اقساطی اسنپ‌پی" },
  { code: "wallet", title: "کیف پول" },
] as const;

const isTruthyEnv = (value?: string): boolean =>
  ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());

const isLocalUrl = (value?: string): boolean =>
  /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/|$)/i.test(String(value || "").trim());

const resolveZarinPalCallbackUrl = (): string => {
  const baseUrl = String(process.env.URL || "").trim().replace(/\/$/, "");
  return String(
    process.env.ZARINPAL_CALLBACK_URL ||
      (baseUrl ? `${baseUrl}/api/orders/payment-callback` : ""),
  ).trim();
};

/**
 * ZarinPal is additive and OFF by default: it only becomes available once the
 * merchant credential is configured via env. Local deterministic E2E/dev
 * callbacks are also treated as configured because they never touch ZarinPal.
 */
const isZarinPalConfigured = (): boolean =>
  Boolean(String(process.env.ZARINPAL_MERCHANT_ID || "").trim()) ||
  isTruthyEnv(process.env.ZARINPAL_E2E_DETERMINISTIC) ||
  isLocalUrl(resolveZarinPalCallbackUrl());

const hasNonEmptyEnv = (...keys: string[]): boolean =>
  keys.every((key) => Boolean(String(process.env[key] || "").trim()));

const isGatewayConfigured = (code: CheckoutGatewayCode): boolean => {
  switch (code) {
    case "samankish":
      return hasNonEmptyEnv("SAMAN_TERMINAL_ID", "SAMAN_USERNAME", "SAMAN_PASSWORD");
    case "mellat":
      return hasNonEmptyEnv("MELLAT_TERMINAL_ID", "MELLAT_USERNAME", "MELLAT_PASSWORD");
    case "snappay":
      return (
        isTruthyEnv(process.env.SNAPPAY_HARDENED_INITIATION_ENABLED) &&
        hasNonEmptyEnv(
          "SNAPPAY_BASE_URL",
          "SNAPPAY_CLIENT_ID",
          "SNAPPAY_CLIENT_SECRET",
          "SNAPPAY_USERNAME",
          "SNAPPAY_PASSWORD",
          "SNAPPAY_RETURN_URL",
          "PAYMENT_TOKEN_ENCRYPTION_KEY",
          "PAYMENT_TOKEN_ENCRYPTION_KEY_VERSION",
        )
      );
    case "zarinpal":
      return isZarinPalConfigured();
    case "wallet":
      return true;
  }
};

const SUPPORTED_CODES = new Set<CheckoutGatewayCode>(
  SUPPORTED_CHECKOUT_GATEWAYS.map((gateway) => gateway.code),
);

const normalizeText = (value: unknown): string =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

/**
 * SnappPay is stored in two forms in this codebase: the canonical checkout
 * code (`snappay`) and the provider/display name (`SnappPay`). Lowercasing the
 * latter produces `snapppay`, so a direct lowercase equality check is unsafe.
 */
export const isSnappayGatewayValue = (value: unknown): boolean => {
  const normalized = normalizeText(value).replace(/[\s!_-]+/g, "");
  return (
    normalized === "snappay" ||
    normalized === "snapppay" ||
    normalized.includes("اسنپ")
  );
};

const mapGatewayTitleToCode = (title: unknown): CheckoutGatewayCode | null => {
  const normalized = normalizeText(title);
  if (!normalized) return null;

  if (isSnappayGatewayValue(normalized)) return "snappay";
  if (normalized.includes("zarin") || normalized.includes("زرین")) return "zarinpal";
  if (normalized.includes("saman") || normalized.includes("سامان")) return "samankish";
  if (normalized.includes("mellat") || normalized.includes("ملت")) return "mellat";
  if (normalized.includes("wallet") || normalized.includes("کیف")) return "wallet";

  return null;
};

const resolveGatewayAvailabilityMap = async (
  strapi: Strapi,
): Promise<Map<CheckoutGatewayCode, boolean>> => {
  const availability = new Map<CheckoutGatewayCode, boolean>();
  for (const gateway of SUPPORTED_CHECKOUT_GATEWAYS) {
    availability.set(gateway.code, false);
  }

  try {
    const rows = (await strapi.entityService.findMany(
      "api::payment-gateway.payment-gateway",
      {
        fields: ["Title", "IsActive"],
        pagination: { page: 1, pageSize: 200 },
      },
    )) as Array<{ Title?: string; IsActive?: boolean }> | null;

    for (const row of rows || []) {
      const mappedCode = mapGatewayTitleToCode(row?.Title);
      if (!mappedCode || !SUPPORTED_CODES.has(mappedCode)) continue;
      if (row?.IsActive !== true) continue;

      availability.set(mappedCode, isGatewayConfigured(mappedCode));
    }

    return availability;
  } catch (error) {
    strapi.log.error("resolveGatewayAvailabilityMap: failed to fetch payment gateways", {
      error,
    });
    return new Map<CheckoutGatewayCode, boolean>();
  }
};

export const getAvailableCheckoutGateways = async (
  strapi: Strapi,
): Promise<CheckoutGatewayItem[]> => {
  const availability = await resolveGatewayAvailabilityMap(strapi);
  return SUPPORTED_CHECKOUT_GATEWAYS.filter(
    (gateway) => availability.get(gateway.code) === true,
  );
};

export const normalizeCheckoutGatewayCode = (
  rawGateway?: string | null,
): CheckoutGatewayCode | null => {
  const normalized = normalizeText(rawGateway);
  if (!normalized) return null;

  if (normalized === "saman" || normalized === "samankish") return "samankish";
  if (normalized === "mellat") return "mellat";
  if (isSnappayGatewayValue(normalized)) return "snappay";
  if (normalized === "wallet") return "wallet";
  if (normalized === "zarinpal" || normalized === "zarin-pal") return "zarinpal";

  return null;
};

export const isCheckoutGatewayEnabled = async (
  strapi: Strapi,
  gatewayCode: CheckoutGatewayCode,
): Promise<boolean> => {
  const availability = await resolveGatewayAvailabilityMap(strapi);
  return availability.get(gatewayCode) === true;
};
