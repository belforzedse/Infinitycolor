import { isWalletTopupUiEnabled } from "../walletTopup";

describe("wallet top-up storefront switch", () => {
  const originalValue = process.env.NEXT_PUBLIC_WALLET_TOPUP_UI_ENABLED;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.NEXT_PUBLIC_WALLET_TOPUP_UI_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_WALLET_TOPUP_UI_ENABLED = originalValue;
    }
  });

  it("defaults to disabled when the flag is absent", () => {
    delete process.env.NEXT_PUBLIC_WALLET_TOPUP_UI_ENABLED;

    expect(isWalletTopupUiEnabled()).toBe(false);
  });

  it("enables the UI only for the exact value true", () => {
    process.env.NEXT_PUBLIC_WALLET_TOPUP_UI_ENABLED = "true";
    expect(isWalletTopupUiEnabled()).toBe(true);

    process.env.NEXT_PUBLIC_WALLET_TOPUP_UI_ENABLED = "false";
    expect(isWalletTopupUiEnabled()).toBe(false);
  });
});
