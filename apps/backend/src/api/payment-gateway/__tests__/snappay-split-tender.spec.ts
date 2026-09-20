import { planSnappayTenderAdjustment } from "../services/snappay-split-tender";

const attempt = {
  Amount: 12_000_000,
  WalletAmount: 3_500_000,
  GatewayAmount: 8_500_000,
};

describe("SnappPay split-tender refunds", () => {
  it("sends only the financed remainder to SnappPay and refunds wallet credit proportionally", () => {
    expect(
      planSnappayTenderAdjustment({
        attempt,
        transactions: [],
        expectedOldTotalToman: 1_200_000,
        newTotalToman: 1_080_000,
      }),
    ).toEqual({
      refundIrr: 1_200_000,
      walletRefundIrr: 350_000,
      gatewayRefundIrr: 850_000,
      walletRemainingIrr: 3_150_000,
      gatewayRemainingIrr: 7_650_000,
    });
  });

  it("uses cumulative allocations so sequential refunds end exactly at both original legs", () => {
    const first = planSnappayTenderAdjustment({
      attempt,
      transactions: [],
      expectedOldTotalToman: 1_200_000,
      newTotalToman: 1_080_000,
    });
    const second = planSnappayTenderAdjustment({
      attempt,
      transactions: [
        {
          Type: "Return",
          Amount: first.refundIrr,
          GatewayResponse: {
            walletLegIrr: first.walletRefundIrr,
            gatewayLegIrr: first.gatewayRefundIrr,
          },
        },
      ],
      expectedOldTotalToman: 1_080_000,
      newTotalToman: 0,
    });

    expect(first.walletRefundIrr + second.walletRefundIrr).toBe(3_500_000);
    expect(first.gatewayRefundIrr + second.gatewayRefundIrr).toBe(8_500_000);
    expect(second.walletRemainingIrr).toBe(0);
    expect(second.gatewayRemainingIrr).toBe(0);
  });

  it("fails closed when the stored refund history cannot reconcile", () => {
    expect(() =>
      planSnappayTenderAdjustment({
        attempt,
        transactions: [{ Type: "Return", Amount: 100_000, GatewayResponse: {} }],
        expectedOldTotalToman: 1_200_000,
        newTotalToman: 1_100_000,
      }),
    ).toThrow("SNAPPAY_SPLIT_REFUND_HISTORY_MISMATCH");
  });
});
