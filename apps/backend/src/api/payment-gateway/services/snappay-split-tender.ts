import { allocateRefundAcrossLegs } from "../../order/controllers/helpers/adminOrderIntegrity";
import { readPaymentAttemptLegs } from "../../payment-attempt/services/payment-legs";

export type SnappayTenderAdjustment = {
  refundIrr: number;
  walletRefundIrr: number;
  gatewayRefundIrr: number;
  walletRemainingIrr: number;
  gatewayRemainingIrr: number;
};

const positiveInt = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
};

const recordedRefunds = (transactions: any[]) => {
  let totalIrr = 0;
  let walletIrr = 0;
  for (const transaction of transactions || []) {
    if (String(transaction?.Type || "").toLowerCase() !== "return") continue;
    const amountIrr = positiveInt(transaction?.Amount);
    totalIrr += amountIrr;
    walletIrr += Math.min(amountIrr, positiveInt(transaction?.GatewayResponse?.walletLegIrr));
  }
  return { totalIrr, walletIrr };
};

/**
 * Keeps SnappPay's financed amount and Infinity's wallet contribution aligned
 * with the provider equation:
 *
 * cart total - discount - externalSourceAmount = amount
 *
 * Refunds are allocated cumulatively, so a series of partial changes ends at
 * the exact original wallet/gateway split without per-step rounding drift.
 */
export function planSnappayTenderAdjustment(input: {
  attempt: any;
  transactions: any[];
  expectedOldTotalToman: number;
  newTotalToman: number;
}): SnappayTenderAdjustment {
  const expectedOldIrr = Math.round(Number(input.expectedOldTotalToman) * 10);
  const newTotalIrr = Math.round(Number(input.newTotalToman) * 10);
  if (
    !Number.isSafeInteger(expectedOldIrr) ||
    !Number.isSafeInteger(newTotalIrr) ||
    expectedOldIrr < 0 ||
    newTotalIrr < 0 ||
    newTotalIrr > expectedOldIrr
  ) {
    throw new Error("SNAPPAY_ADMIN_UPDATE_AMOUNT_MISMATCH");
  }

  const legs = readPaymentAttemptLegs(input.attempt);
  const originalWalletIrr = legs.walletIrr;
  const originalGatewayIrr = legs.hasWalletLeg
    ? legs.gatewayIrr
    : Math.max(legs.gatewayIrr, expectedOldIrr);
  const originalTotalIrr = originalWalletIrr + originalGatewayIrr;

  // Legacy/non-split attempts may have had Amount reduced by an older admin
  // update. Their provider leg is simply the current order total.
  if (!legs.hasWalletLeg) {
    return {
      refundIrr: expectedOldIrr - newTotalIrr,
      walletRefundIrr: 0,
      gatewayRefundIrr: expectedOldIrr - newTotalIrr,
      walletRemainingIrr: 0,
      gatewayRemainingIrr: newTotalIrr,
    };
  }

  if (originalTotalIrr <= 0 || expectedOldIrr > originalTotalIrr) {
    throw new Error("SNAPPAY_SPLIT_FUNDING_MISMATCH");
  }

  const prior = recordedRefunds(input.transactions);
  const expectedPriorRefundIrr = originalTotalIrr - expectedOldIrr;
  if (prior.totalIrr !== expectedPriorRefundIrr || prior.walletIrr > originalWalletIrr) {
    throw new Error("SNAPPAY_SPLIT_REFUND_HISTORY_MISMATCH");
  }

  const refundIrr = expectedOldIrr - newTotalIrr;
  const allocation = allocateRefundAcrossLegs({
    refundIrr,
    priorRefundedIrr: prior.totalIrr,
    priorWalletAllocatedIrr: prior.walletIrr,
    walletFundingIrr: originalWalletIrr,
    totalFundingIrr: originalTotalIrr,
  });
  const cumulativeWalletRefundIrr = prior.walletIrr + allocation.walletIrr;
  const cumulativeGatewayRefundIrr = prior.totalIrr - prior.walletIrr + allocation.gatewayIrr;
  const walletRemainingIrr = originalWalletIrr - cumulativeWalletRefundIrr;
  const gatewayRemainingIrr = originalGatewayIrr - cumulativeGatewayRefundIrr;

  if (
    walletRemainingIrr < 0 ||
    gatewayRemainingIrr < 0 ||
    walletRemainingIrr + gatewayRemainingIrr !== newTotalIrr
  ) {
    throw new Error("SNAPPAY_SPLIT_REFUND_ALLOCATION_MISMATCH");
  }

  return {
    refundIrr,
    walletRefundIrr: allocation.walletIrr,
    gatewayRefundIrr: allocation.gatewayIrr,
    walletRemainingIrr,
    gatewayRemainingIrr,
  };
}
