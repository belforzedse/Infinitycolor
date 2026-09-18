import {
  dropExpectedCheckoutSentryEvent,
  EXPECTED_CHECKOUT_SENTRY_IGNORE,
  isExpectedCheckoutSentryCode,
  isExpectedCheckoutSentryMessage,
} from "../expected-checkout-sentry";

describe("expected checkout Sentry filters", () => {
  it("recognizes the SnapPay leftover codes that still leaked after cutover", () => {
    expect(isExpectedCheckoutSentryCode("SNAPPAY_MANUAL_REVIEW")).toBe(true);
    expect(isExpectedCheckoutSentryCode("SNAPPAY_RECONCILIATION_PENDING")).toBe(true);
    expect(isExpectedCheckoutSentryCode("RESERVATION_EXPIRED")).toBe(true);
    expect(isExpectedCheckoutSentryCode("RESERVATION_LOOKUP_FAILED")).toBe(true);
    expect(isExpectedCheckoutSentryMessage("checkout.error:RESERVATION_EXPIRED")).toBe(true);
    expect(isExpectedCheckoutSentryMessage("checkout.error:RESERVATION_LOOKUP_FAILED")).toBe(true);
    expect(isExpectedCheckoutSentryMessage("checkout.error:SNAPPAY_MANUAL_REVIEW")).toBe(true);
    expect(EXPECTED_CHECKOUT_SENTRY_IGNORE.test("checkout.error:PAYMENT_IN_PROGRESS")).toBe(true);
  });

  it("still reports unexpected checkout failures", () => {
    expect(isExpectedCheckoutSentryCode("WALLET_DEBIT_FAILED")).toBe(false);
    expect(isExpectedCheckoutSentryMessage("checkout.error:WALLET_DEBIT_FAILED")).toBe(false);
    expect(dropExpectedCheckoutSentryEvent({ message: "checkout.error:WALLET_DEBIT_FAILED" })).toEqual(
      { message: "checkout.error:WALLET_DEBIT_FAILED" },
    );
  });

  it("drops expected checkout events even when the title is on the exception value", () => {
    expect(dropExpectedCheckoutSentryEvent({ message: "checkout.error:SNAPPAY_MANUAL_REVIEW" })).toBeNull();
    expect(
      dropExpectedCheckoutSentryEvent({
        exception: { values: [{ value: "checkout.error:SNAPPAY_RECONCILIATION_PENDING" }] },
      }),
    ).toBeNull();
  });
});
