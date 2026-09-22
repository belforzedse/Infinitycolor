import {
  readOrderPaymentLegs,
  primaryGatewayMethod,
  type PaymentLegTransaction,
} from "../paymentLegs";

const tx = (overrides: Partial<PaymentLegTransaction>): PaymentLegTransaction => ({
  Type: "Gateway",
  Status: "Success",
  ...overrides,
});

describe("readOrderPaymentLegs", () => {
  it("returns a single leg for a gateway-only order", () => {
    const legs = readOrderPaymentLegs([
      tx({ SettlementGateway: "SnappPay", Amount: 23_490_000 }),
    ]);

    expect(legs).toEqual([
      { method: "snappay", label: "اسنپ! پی", amountIrr: 23_490_000, isWallet: false },
    ]);
  });

  it("returns both legs for a wallet + SnappPay split, largest first", () => {
    // Order 50919 in production: SnappPay 315,000 T + Wallet 2,899,000 T.
    const legs = readOrderPaymentLegs([
      tx({ SettlementGateway: "SnappPay", Amount: 3_150_000 }),
      tx({ SettlementGateway: "Wallet", Amount: 28_990_000 }),
    ]);

    expect(legs.map((l) => [l.label, l.amountIrr])).toEqual([
      ["کیف پول", 28_990_000],
      ["اسنپ! پی", 3_150_000],
    ]);
    expect(legs[0].isWallet).toBe(true);
    expect(legs[1].isWallet).toBe(false);
  });

  it("resolves a bank leg that only carries external_source", () => {
    // Mellat / SamanKish / ZarinPal settlement writes external_source but leaves
    // SettlementGateway null, so reading only the latter loses the leg entirely.
    const legs = readOrderPaymentLegs([
      tx({ SettlementGateway: null, external_source: "Mellat", Amount: 2_100_000 }),
      tx({ SettlementGateway: "Wallet", Amount: 47_980_000 }),
    ]);

    expect(legs.map((l) => l.label)).toEqual(["کیف پول", "بانک ملت"]);
  });

  it("prefers SettlementGateway over the importer's provenance marker", () => {
    const legs = readOrderPaymentLegs([
      tx({ SettlementGateway: "SamanKish", external_source: "woocommerce", Amount: 1_500_000 }),
    ]);

    expect(legs).toHaveLength(1);
    expect(legs[0].label).toBe("سامان کیش");
  });

  it("drops a row whose only channel value is the provenance marker", () => {
    const legs = readOrderPaymentLegs([
      tx({ SettlementGateway: null, external_source: "woocommerce", Amount: 1_000_000 }),
    ]);

    expect(legs).toEqual([]);
  });

  it("excludes Return rows so refunds are not counted as funding", () => {
    const legs = readOrderPaymentLegs([
      tx({ SettlementGateway: "SnappPay", Amount: 5_000_000 }),
      tx({ Type: "Return", SettlementGateway: "Wallet", Amount: 1_000_000 }),
    ]);

    expect(legs.map((l) => l.label)).toEqual(["اسنپ! پی"]);
  });

  it("collapses repeated legs of the same method into one summed row", () => {
    const legs = readOrderPaymentLegs([
      tx({ SettlementGateway: "Wallet", Amount: 1_000_000 }),
      tx({ SettlementGateway: "wallet", Amount: 2_000_000 }),
    ]);

    expect(legs).toHaveLength(1);
    expect(legs[0].amountIrr).toBe(3_000_000);
  });

  it("ignores rows with no amount and handles no transactions at all", () => {
    expect(readOrderPaymentLegs([tx({ SettlementGateway: "Wallet", Amount: 0 })])).toEqual([]);
    expect(readOrderPaymentLegs([])).toEqual([]);
    expect(readOrderPaymentLegs(null)).toEqual([]);
    expect(readOrderPaymentLegs(undefined)).toEqual([]);
  });

  it("keeps an unrecognised channel rather than hiding the money", () => {
    const legs = readOrderPaymentLegs([
      tx({ SettlementGateway: "OffGateway", Amount: 4_000_000 }),
    ]);

    expect(legs[0].amountIrr).toBe(4_000_000);
    expect(legs[0].label).toBe("پرداخت خارج از درگاه");
  });
});

describe("primaryGatewayMethod", () => {
  it("picks the gateway, not the wallet, on a split order", () => {
    // The regression this exists for: the wallet leg is written later, so taking
    // the last transaction made a SnappPay order look like a wallet order and
    // hid the SnappPay operator panels.
    const legs = readOrderPaymentLegs([
      tx({ SettlementGateway: "SnappPay", Amount: 3_150_000 }),
      tx({ SettlementGateway: "Wallet", Amount: 28_990_000 }),
    ]);

    expect(primaryGatewayMethod(legs)).toBe("snappay");
  });

  it("falls back to the wallet when it is the only funding", () => {
    const legs = readOrderPaymentLegs([tx({ SettlementGateway: "Wallet", Amount: 9_000_000 })]);

    expect(primaryGatewayMethod(legs)).toBe("wallet");
  });

  it("returns undefined when there are no legs", () => {
    expect(primaryGatewayMethod([])).toBeUndefined();
  });
});
