/**
 * Reading the two legs of a payment attempt.
 *
 * `payment_attempts.Amount` is, and stays, the order total in IRR — admin
 * update, payment-status and the SnappPay resume checks all read it. When a
 * customer pays part of an order from their wallet, `WalletAmount` and
 * `GatewayAmount` record the split, and it is `GatewayAmount` that the bank was
 * actually asked to charge. Comparing a provider's settled amount against the
 * total would then fail every split payment and reverse it.
 *
 * Both legs are immutable funding facts: they record what was charged where,
 * and are never rewritten when an order is later adjusted or refunded.
 */

export type PaymentAttemptLegs = {
  totalIrr: number;
  walletIrr: number;
  gatewayIrr: number;
  hasWalletLeg: boolean;
};

const toIrr = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

export function readPaymentAttemptLegs(
  attempt: any,
  fallbackTotalIrr = 0,
): PaymentAttemptLegs {
  const totalIrr = attempt?.Amount != null ? toIrr(attempt.Amount) : toIrr(fallbackTotalIrr);
  const walletIrr = Math.max(0, toIrr(attempt?.WalletAmount));
  const hasWalletLeg = walletIrr > 0;
  const gatewayIrr = hasWalletLeg
    ? attempt?.GatewayAmount != null
      ? toIrr(attempt.GatewayAmount)
      : Math.max(0, totalIrr - walletIrr)
    : totalIrr;
  return { totalIrr, walletIrr, gatewayIrr, hasWalletLeg };
}

/** What the provider was asked to charge, in IRR. */
export const gatewayExpectedAmountIrr = (attempt: any, fallbackTotalIrr = 0): number =>
  readPaymentAttemptLegs(attempt, fallbackTotalIrr).gatewayIrr;
