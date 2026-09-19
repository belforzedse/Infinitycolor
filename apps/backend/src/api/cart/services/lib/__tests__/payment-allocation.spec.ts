import {
  buildPaymentCapabilities,
  gatewayMinimumToman,
  irrToSpendableToman,
  normalizeWalletAmountInput,
  PaymentAllocationError,
  resolvePaymentAllocation,
  tomanToIrr,
  type PaymentCapabilities,
} from "../payment-allocation";

const capabilities = (over: Partial<PaymentCapabilities> = {}): PaymentCapabilities => ({
  ...buildPaymentCapabilities({
    walletGatewayAvailable: true,
    splitEnabled: true,
    snappaySplitEnabled: false,
  }),
  ...over,
});

const allocate = (over: Partial<Parameters<typeof resolvePaymentAllocation>[0]> = {}) =>
  resolvePaymentAllocation({
    totalToman: 1_200_000,
    requestedWalletAmount: 350_000,
    selectedGateway: "zarinpal",
    balanceIrr: 5_000_000,
    heldIrr: 0,
    availableIrr: 5_000_000,
    reusableIrr: 0,
    capabilities: capabilities(),
    ...over,
  });

describe("wallet amount normalisation", () => {
  it("accepts Persian and Arabic-Indic digits with separators", () => {
    expect(normalizeWalletAmountInput("۳۵۰٬۰۰۰")).toBe(350_000);
    expect(normalizeWalletAmountInput("٣٥٠,٠٠٠")).toBe(350_000);
    expect(normalizeWalletAmountInput(" 350 000 ")).toBe(350_000);
  });

  it("treats an empty value as no wallet contribution", () => {
    expect(normalizeWalletAmountInput("")).toBe(0);
    expect(normalizeWalletAmountInput(null)).toBe(0);
    expect(normalizeWalletAmountInput(undefined)).toBe(0);
  });

  it("rejects malformed input instead of silently coercing it", () => {
    for (const bad of ["12a3", "1.5", "-100", "1e5", "٣٥٠x", {}, []]) {
      expect(() => normalizeWalletAmountInput(bad as unknown)).toThrow(PaymentAllocationError);
    }
    expect(() => normalizeWalletAmountInput(-1)).toThrow(/نامنفی/);
    expect(() => normalizeWalletAmountInput(1.5)).toThrow(PaymentAllocationError);
  });
});

describe("money bounds", () => {
  it("converts toman to IRR exactly once and checks both sides", () => {
    expect(tomanToIrr(350_000)).toBe(3_500_000);
    expect(tomanToIrr(0)).toBe(0);
    expect(() => tomanToIrr(Number.MAX_SAFE_INTEGER)).toThrow(/overflows/);
    expect(() => tomanToIrr(-1)).toThrow(PaymentAllocationError);
  });

  it("never rounds a fractional legacy balance up into spendable credit", () => {
    expect(irrToSpendableToman(10_005)).toBe(1_000);
    expect(irrToSpendableToman(9)).toBe(0);
    expect(irrToSpendableToman(-50)).toBe(0);
  });
});

describe("allocation", () => {
  it("splits the acceptance example: 1,200,000 total, 350,000 from a 500,000 wallet", () => {
    const allocation = allocate({
      balanceIrr: 5_000_000,
      availableIrr: 5_000_000,
      requestedWalletAmount: 350_000,
    });
    expect(allocation).toMatchObject({
      totalToman: 1_200_000,
      walletToman: 350_000,
      gatewayToman: 850_000,
      requiredGateway: "zarinpal",
    });
    expect(allocation.walletToman + allocation.gatewayToman).toBe(allocation.totalToman);
  });

  it("leaves a zero-wallet checkout completely untouched", () => {
    const allocation = allocate({ requestedWalletAmount: 0, selectedGateway: "mellat" });
    expect(allocation).toMatchObject({
      walletToman: 0,
      gatewayToman: 1_200_000,
      requiredGateway: "mellat",
    });
  });

  it("routes to wallet-only when credit exactly covers the total", () => {
    const allocation = allocate({
      totalToman: 500_000,
      requestedWalletAmount: 500_000,
      selectedGateway: "zarinpal",
    });
    expect(allocation).toMatchObject({
      walletToman: 500_000,
      gatewayToman: 0,
      requiredGateway: "wallet",
    });
  });

  it("keeps the legacy wallet-only contract when no amount is supplied", () => {
    const allocation = allocate({
      selectedGateway: "wallet",
      requestedWalletAmount: undefined,
      totalToman: 120_000,
    });
    expect(allocation).toMatchObject({ walletToman: 120_000, gatewayToman: 0, requiredGateway: "wallet" });
  });

  it("forces a zero-total order to tender nothing", () => {
    const allocation = allocate({ totalToman: 0, requestedWalletAmount: 50_000 });
    expect(allocation).toMatchObject({ walletToman: 0, gatewayToman: 0 });
  });

  it("rejects a partial amount submitted against the wallet gateway", () => {
    expect(() =>
      allocate({ selectedGateway: "wallet", requestedWalletAmount: 350_000 }),
    ).toThrow(expect.objectContaining({ code: "WALLET_COVERS_TOTAL" }));
  });

  it("rejects more wallet than the order costs", () => {
    expect(() => allocate({ requestedWalletAmount: 1_300_000 })).toThrow(
      expect.objectContaining({ code: "WALLET_AMOUNT_INVALID" }),
    );
  });

  it("reports an ordinary shortfall separately from credit held by a live payment", () => {
    expect(() =>
      allocate({ requestedWalletAmount: 350_000, balanceIrr: 1_000_000, availableIrr: 1_000_000 }),
    ).toThrow(expect.objectContaining({ code: "WALLET_INSUFFICIENT_AVAILABLE" }));

    expect(() =>
      allocate({
        requestedWalletAmount: 350_000,
        balanceIrr: 5_000_000,
        heldIrr: 4_000_000,
        availableIrr: 1_000_000,
      }),
    ).toThrow(expect.objectContaining({ code: "WALLET_FUNDS_HELD_BY_PENDING_PAYMENT" }));
  });

  it("counts the named predecessor's hold as reusable, and reports it separately", () => {
    const allocation = allocate({
      requestedWalletAmount: 350_000,
      balanceIrr: 5_000_000,
      heldIrr: 3_500_000,
      availableIrr: 1_500_000,
      reusableIrr: 3_500_000,
    });
    expect(allocation).toMatchObject({
      walletToman: 350_000,
      walletAvailableToman: 150_000,
      walletReusableToman: 350_000,
      walletHeldToman: 350_000,
    });
  });

  it("refuses a residual below the gateway minimum", () => {
    expect(() =>
      allocate({
        totalToman: 1_200_000,
        requestedWalletAmount: 1_199_500,
        balanceIrr: 20_000_000,
        availableIrr: 20_000_000,
      }),
    ).toThrow(expect.objectContaining({ code: "WALLET_RESIDUAL_BELOW_GATEWAY_MINIMUM" }));
  });

  it("refuses a split when the capability is off, and when the gateway cannot carry one", () => {
    expect(() =>
      allocate({
        capabilities: buildPaymentCapabilities({
          walletGatewayAvailable: true,
          splitEnabled: false,
          snappaySplitEnabled: false,
        }),
      }),
    ).toThrow(expect.objectContaining({ code: "WALLET_SPLIT_DISABLED" }));

    expect(() => allocate({ selectedGateway: "snappay" })).toThrow(
      expect.objectContaining({ code: "WALLET_SPLIT_UNSUPPORTED_GATEWAY" }),
    );
  });

  it("allows SnappPay only when its own capability is on", () => {
    const allocation = allocate({
      selectedGateway: "snappay",
      capabilities: buildPaymentCapabilities({
        walletGatewayAvailable: true,
        splitEnabled: true,
        snappaySplitEnabled: true,
      }),
    });
    expect(allocation).toMatchObject({ walletToman: 350_000, gatewayToman: 850_000 });
  });

  it("says the balance is unreadable rather than telling the customer it is too low", () => {
    expect(() => allocate({ balanceUnavailable: true })).toThrow(
      expect.objectContaining({ code: "WALLET_UNAVAILABLE" }),
    );
    // A checkout that is not using the wallet is unaffected by the same outage.
    expect(
      allocate({ balanceUnavailable: true, requestedWalletAmount: 0 }),
    ).toMatchObject({ walletToman: 0, gatewayToman: 1_200_000 });
  });

  it("refuses any wallet tender when the wallet gateway itself is unavailable", () => {
    expect(() =>
      allocate({
        capabilities: buildPaymentCapabilities({
          walletGatewayAvailable: false,
          splitEnabled: true,
          snappaySplitEnabled: false,
        }),
      }),
    ).toThrow(expect.objectContaining({ code: "WALLET_DISABLED" }));
  });
});

describe("capabilities", () => {
  it("always states why a split is unavailable rather than omitting the field", () => {
    const off = buildPaymentCapabilities({
      walletGatewayAvailable: true,
      splitEnabled: false,
      snappaySplitEnabled: false,
    });
    expect(off).toMatchObject({ splitEnabled: false, splitDisabledReason: "disabled", splitGateways: [] });
  });

  it("reads a configured store minimum but keeps the provider floor for ZarinPal", () => {
    const previous = process.env.CHECKOUT_GATEWAY_MIN_RESIDUAL_TOMAN_MELLAT;
    process.env.CHECKOUT_GATEWAY_MIN_RESIDUAL_TOMAN_MELLAT = "25000";
    try {
      expect(gatewayMinimumToman("mellat")).toBe(25_000);
      expect(gatewayMinimumToman("zarinpal")).toBe(1_000);
    } finally {
      if (previous === undefined) delete process.env.CHECKOUT_GATEWAY_MIN_RESIDUAL_TOMAN_MELLAT;
      else process.env.CHECKOUT_GATEWAY_MIN_RESIDUAL_TOMAN_MELLAT = previous;
    }
  });
});
