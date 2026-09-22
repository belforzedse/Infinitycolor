import { allocateRefundAcrossLegs } from "../adminOrderIntegrity";

/**
 * Refund reporting for a split payment.
 *
 * The money always goes to the wallet; what these assert is that the *record*
 * of which leg it came from stays exact across a series of partial refunds and
 * adds back up to the original funding when everything is returned.
 */
const allocate = (
  refundIrr: number,
  prior: { refunded: number; wallet: number } = { refunded: 0, wallet: 0 },
) =>
  allocateRefundAcrossLegs({
    refundIrr,
    priorRefundedIrr: prior.refunded,
    priorWalletAllocatedIrr: prior.wallet,
    walletFundingIrr: 3_500_000,
    totalFundingIrr: 12_000_000,
  });

describe("refund allocation across funding legs", () => {
  it("splits a single refund in proportion to what funded the order", () => {
    // 3,500,000 of 12,000,000 came from the wallet.
    expect(allocate(12_000_000)).toEqual({ walletIrr: 3_500_000, gatewayIrr: 8_500_000 });
  });

  it("never allocates more than the wallet actually funded", () => {
    const first = allocate(12_000_000);
    const second = allocate(1_000_000, { refunded: 12_000_000, wallet: first.walletIrr });
    expect(second.walletIrr).toBe(0);
  });

  it("reconciles a series of partial refunds back to the original legs", () => {
    const steps = [1_000_000, 4_000_000, 2_500_000, 4_500_000];
    let refunded = 0;
    let wallet = 0;
    let gateway = 0;

    for (const step of steps) {
      const allocation = allocate(step, { refunded, wallet });
      expect(allocation.walletIrr + allocation.gatewayIrr).toBe(step);
      refunded += step;
      wallet += allocation.walletIrr;
      gateway += allocation.gatewayIrr;
    }

    // Independently rounding each step would drift; a cumulative entitlement
    // minus what was already allocated cannot.
    expect(refunded).toBe(12_000_000);
    expect(wallet).toBe(3_500_000);
    expect(gateway).toBe(8_500_000);
  });

  it("rounds down the wallet share so it can never exceed the wallet leg", () => {
    const allocation = allocateRefundAcrossLegs({
      refundIrr: 1,
      priorRefundedIrr: 0,
      priorWalletAllocatedIrr: 0,
      walletFundingIrr: 1,
      totalFundingIrr: 3,
    });
    expect(allocation).toEqual({ walletIrr: 0, gatewayIrr: 1 });
  });

  it("attributes everything to the gateway when no wallet credit was used", () => {
    expect(
      allocateRefundAcrossLegs({
        refundIrr: 5_000_000,
        priorRefundedIrr: 0,
        priorWalletAllocatedIrr: 0,
        walletFundingIrr: 0,
        totalFundingIrr: 5_000_000,
      }),
    ).toEqual({ walletIrr: 0, gatewayIrr: 5_000_000 });
  });

  it("returns nothing for a non-positive refund", () => {
    expect(allocate(0)).toEqual({ walletIrr: 0, gatewayIrr: 0 });
    expect(allocate(-100)).toEqual({ walletIrr: 0, gatewayIrr: 0 });
  });
});
