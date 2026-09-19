/**
 * Splitting an order total between wallet credit and a bank gateway.
 *
 * Wallet credit is a *tender*, not a discount: the order total never changes,
 * the wallet pays part of it and the gateway is asked for the rest. `T = W + G`
 * holds exactly, in toman, at every step. The single toman→IRR conversion
 * happens where the attempt, hold and contract-transaction rows are written —
 * never here.
 *
 * This module is pure so the arithmetic and the capability rules can be tested
 * without a database, a gateway or a Strapi instance.
 */

export type CheckoutGatewayCode =
  | "mellat"
  | "samankish"
  | "zarinpal"
  | "snappay"
  | "wallet";

export const WALLET_ALLOCATION_ERROR_CODES = [
  "WALLET_AMOUNT_INVALID",
  "WALLET_INSUFFICIENT_AVAILABLE",
  "WALLET_FUNDS_HELD_BY_PENDING_PAYMENT",
  "WALLET_COVERS_TOTAL",
  "WALLET_RESIDUAL_BELOW_GATEWAY_MINIMUM",
  "WALLET_SPLIT_DISABLED",
  "WALLET_SPLIT_UNSUPPORTED_GATEWAY",
  "WALLET_DISABLED",
] as const;

export type WalletAllocationErrorCode = (typeof WALLET_ALLOCATION_ERROR_CODES)[number];

export class PaymentAllocationError extends Error {
  constructor(
    readonly code: WalletAllocationErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PaymentAllocationError";
  }
}

/**
 * What the server will accept, reported on every quote.
 *
 * The storefront must never infer a feature flag from a missing field: when
 * split is off, `splitEnabled` is `false` with a `splitDisabledReason`, and the
 * wallet card renders as wallet-only instead of silently disappearing.
 */
export type PaymentCapabilities = {
  walletEnabled: boolean;
  splitEnabled: boolean;
  splitDisabledReason: "disabled" | "unsupported_gateway" | null;
  splitGateways: CheckoutGatewayCode[];
  gatewayMinimumsToman: Record<string, number>;
};

export type PaymentAllocation = {
  totalToman: number;
  walletToman: number;
  gatewayToman: number;
  walletBalanceToman: number;
  walletHeldToman: number;
  /** Spendable right now: posted balance minus every hold. */
  walletAvailableToman: number;
  /**
   * Held by the one predecessor checkout this request may supersede. Reported
   * separately because it is not spendable until that attempt is superseded.
   */
  walletReusableToman: number;
  /** The gateway the client must submit; `wallet` when credit covers the total. */
  requiredGateway: CheckoutGatewayCode;
};

/** Largest exact integer this code will accept as a money amount, in IRR. */
const MAX_SAFE_IRR = 9_007_199_254_740_991;

const PERSIAN_DIGITS = /[۰-۹]/g;
const ARABIC_DIGITS = /[٠-٩]/g;

/**
 * Persian and Arabic-Indic digits arrive from Persian keyboards and from
 * copy-pasted amounts. They are normalised, separators are dropped, and
 * anything else is rejected rather than silently coerced — `"12a3"` must not
 * become `123`.
 */
export function normalizeWalletAmountInput(value: unknown): number {
  if (value == null || value === "") return 0;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new PaymentAllocationError(
        "WALLET_AMOUNT_INVALID",
        "مبلغ کیف پول باید یک عدد صحیح و نامنفی باشد",
      );
    }
    return value;
  }
  const raw = String(value)
    .replace(PERSIAN_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[,٬،\s]/g, "")
    .trim();
  if (!/^\d+$/.test(raw)) {
    throw new PaymentAllocationError(
      "WALLET_AMOUNT_INVALID",
      "مبلغ کیف پول نامعتبر است",
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new PaymentAllocationError(
      "WALLET_AMOUNT_INVALID",
      "مبلغ کیف پول خارج از محدوده مجاز است",
    );
  }
  return parsed;
}

/**
 * Toman → IRR, checked on both sides of the multiplication.
 *
 * The factor is exactly 10 and is applied exactly once per persisted amount.
 * Anything that would leave the exact-integer range is rejected instead of
 * silently losing precision.
 */
export function tomanToIrr(amountToman: number): number {
  if (!Number.isSafeInteger(amountToman) || amountToman < 0) {
    throw new PaymentAllocationError(
      "WALLET_AMOUNT_INVALID",
      `Amount ${amountToman} toman is not a valid money amount`,
    );
  }
  const irr = amountToman * 10;
  if (!Number.isSafeInteger(irr) || irr > MAX_SAFE_IRR) {
    throw new PaymentAllocationError(
      "WALLET_AMOUNT_INVALID",
      `Amount ${amountToman} toman overflows the exact-integer range in IRR`,
    );
  }
  return irr;
}

/**
 * IRR → spendable toman, always rounding **down**.
 *
 * Legacy imported balances are not guaranteed to be multiples of 10. A balance
 * of 10,005 IRR can fund 1,000 toman, not 1,001 — rounding up would let a
 * customer commit five rial they do not have and fail the hold at the database
 * CHECK. The remainder is kept, never discarded: it stays in `balance`.
 */
export const irrToSpendableToman = (amountIrr: number): number =>
  Math.max(0, Math.floor(Number(amountIrr || 0) / 10));

const DEFAULT_GATEWAY_MINIMUM_TOMAN = 1_000;
/** ZarinPal refuses anything under 10,000 IRR (`zarinpal.ts` assertValidAmount). */
const ZARINPAL_MINIMUM_TOMAN = 1_000;

const truthy = (value?: string): boolean =>
  ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());

export const SPLIT_CAPABLE_GATEWAYS: CheckoutGatewayCode[] = [
  "mellat",
  "samankish",
  "zarinpal",
];

/**
 * Store minimums are configurable per gateway; the ZarinPal floor is the
 * provider's own documented limit and is reported as such.
 */
export function gatewayMinimumToman(gateway: string): number {
  const key = `CHECKOUT_GATEWAY_MIN_RESIDUAL_TOMAN_${String(gateway).toUpperCase()}`;
  const configured = Number(process.env[key]);
  if (Number.isInteger(configured) && configured >= 0) return configured;
  return gateway === "zarinpal" ? ZARINPAL_MINIMUM_TOMAN : DEFAULT_GATEWAY_MINIMUM_TOMAN;
}

export function buildPaymentCapabilities(params: {
  walletGatewayAvailable: boolean;
  splitEnabled: boolean;
  snappaySplitEnabled: boolean;
}): PaymentCapabilities {
  const splitGateways = params.splitEnabled
    ? [
        ...SPLIT_CAPABLE_GATEWAYS,
        ...(params.snappaySplitEnabled ? (["snappay"] as CheckoutGatewayCode[]) : []),
      ]
    : [];
  return {
    walletEnabled: params.walletGatewayAvailable,
    splitEnabled: params.splitEnabled && params.walletGatewayAvailable,
    splitDisabledReason: params.splitEnabled ? null : "disabled",
    splitGateways,
    gatewayMinimumsToman: Object.fromEntries(
      [...SPLIT_CAPABLE_GATEWAYS, "snappay"].map((code) => [code, gatewayMinimumToman(code)]),
    ),
  };
}

export type AllocationInput = {
  totalToman: number;
  /** Raw client value; may be a Persian-digit string. */
  requestedWalletAmount: unknown;
  selectedGateway: string;
  balanceIrr: number;
  heldIrr: number;
  availableIrr: number;
  reusableIrr: number;
  capabilities: PaymentCapabilities;
};

/**
 * Resolves `T = W + G` or explains precisely why it cannot.
 *
 * Nothing here consults a feature flag directly: the caller passes the
 * capabilities it already reported on the quote, so a quote and the finalize
 * that follows it can never disagree about what was allowed.
 */
export function resolvePaymentAllocation(input: AllocationInput): PaymentAllocation {
  const totalToman = Number(input.totalToman);
  if (!Number.isSafeInteger(totalToman) || totalToman < 0) {
    throw new PaymentAllocationError(
      "WALLET_AMOUNT_INVALID",
      `Order total ${input.totalToman} is not a valid money amount`,
    );
  }

  const gateway = String(input.selectedGateway || "").trim().toLowerCase();
  const balanceToman = irrToSpendableToman(input.balanceIrr);
  const heldToman = irrToSpendableToman(input.heldIrr);
  const availableToman = irrToSpendableToman(Math.max(0, input.availableIrr));
  const reusableToman = irrToSpendableToman(Math.max(0, input.reusableIrr));

  const base = {
    totalToman,
    walletBalanceToman: balanceToman,
    walletHeldToman: heldToman,
    walletAvailableToman: availableToman,
    walletReusableToman: reusableToman,
  };

  let walletToman = normalizeWalletAmountInput(input.requestedWalletAmount);

  // A zero-total order (fully discounted) keeps its existing path: nothing is
  // tendered, nothing is held.
  if (totalToman === 0) {
    return { ...base, walletToman: 0, gatewayToman: 0, requiredGateway: (gateway || "mellat") as CheckoutGatewayCode };
  }

  // `gateway: "wallet"` without an explicit amount is the pre-existing
  // wallet-only contract and keeps working unchanged.
  if (gateway === "wallet" && walletToman === 0) {
    walletToman = totalToman;
  }

  if (walletToman === 0) {
    return {
      ...base,
      walletToman: 0,
      gatewayToman: totalToman,
      requiredGateway: (gateway || "mellat") as CheckoutGatewayCode,
    };
  }

  if (!input.capabilities.walletEnabled) {
    throw new PaymentAllocationError(
      "WALLET_DISABLED",
      "پرداخت با کیف پول در حال حاضر در دسترس نیست.",
      base,
    );
  }

  if (walletToman > totalToman) {
    throw new PaymentAllocationError(
      "WALLET_AMOUNT_INVALID",
      "مبلغ کیف پول از مبلغ سفارش بیشتر است.",
      { ...base, requestedWalletToman: walletToman },
    );
  }

  const spendableToman = availableToman + reusableToman;
  if (walletToman > spendableToman) {
    // Distinguish "you do not have it" from "another payment of yours is
    // holding it", because only the second is recoverable by the customer.
    const code: WalletAllocationErrorCode =
      heldToman > 0 && walletToman <= balanceToman
        ? "WALLET_FUNDS_HELD_BY_PENDING_PAYMENT"
        : "WALLET_INSUFFICIENT_AVAILABLE";
    throw new PaymentAllocationError(
      code,
      code === "WALLET_FUNDS_HELD_BY_PENDING_PAYMENT"
        ? "بخشی از موجودی کیف پول برای پرداخت در حال انجام رزرو شده است. لطفاً نتیجه آن پرداخت را بررسی کنید."
        : "موجودی قابل استفاده کیف پول کافی نیست. مبلغ را تغییر دهید.",
      { ...base, requestedWalletToman: walletToman },
    );
  }

  // Credit covers the whole order. The gateway is part of the quote hash and is
  // chosen before the total is known, so the server cannot silently rewrite it:
  // it reports the gateway the client must re-quote with.
  if (walletToman === totalToman) {
    return { ...base, walletToman, gatewayToman: 0, requiredGateway: "wallet" };
  }

  if (gateway === "wallet") {
    throw new PaymentAllocationError(
      "WALLET_COVERS_TOTAL",
      "برای پرداخت بخشی از سفارش، یک درگاه بانکی انتخاب کنید.",
      { ...base, requestedWalletToman: walletToman },
    );
  }

  if (!input.capabilities.splitEnabled) {
    throw new PaymentAllocationError(
      "WALLET_SPLIT_DISABLED",
      "پرداخت ترکیبی کیف پول و درگاه در حال حاضر فعال نیست.",
      { ...base, requestedWalletToman: walletToman },
    );
  }

  if (!input.capabilities.splitGateways.includes(gateway as CheckoutGatewayCode)) {
    throw new PaymentAllocationError(
      "WALLET_SPLIT_UNSUPPORTED_GATEWAY",
      "مبلغ پرداخت از کیف پول برای این روش پرداخت قابل استفاده نیست.",
      { ...base, requestedWalletToman: walletToman, gateway },
    );
  }

  const gatewayToman = totalToman - walletToman;
  const minimum = input.capabilities.gatewayMinimumsToman[gateway] ?? gatewayMinimumToman(gateway);
  if (gatewayToman < minimum) {
    throw new PaymentAllocationError(
      "WALLET_RESIDUAL_BELOW_GATEWAY_MINIMUM",
      `باقی‌ماندهٔ پرداخت از درگاه نمی‌تواند کمتر از ${minimum} تومان باشد. یا کل مبلغ را از کیف پول بپردازید یا سهم کیف پول را کم کنید.`,
      { ...base, requestedWalletToman: walletToman, gatewayToman, minimumToman: minimum },
    );
  }

  return {
    ...base,
    walletToman,
    gatewayToman,
    requiredGateway: gateway as CheckoutGatewayCode,
  };
}

export const isWalletSplitAllocation = (allocation: PaymentAllocation): boolean =>
  allocation.walletToman > 0 && allocation.gatewayToman > 0;
