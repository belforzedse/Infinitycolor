import {
  isCheckoutStatusRecoveryCode,
  orderIdFromCheckoutFailure,
  persistPendingPaymentResult,
} from "../checkout-status-recovery";
import { resolveCheckoutAttemptId } from "../checkout-identity";

describe("checkout status recovery", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("treats unknown/in-progress SnapPay leftovers as status-check codes", () => {
    expect(isCheckoutStatusRecoveryCode("PAYMENT_UNKNOWN")).toBe(true);
    expect(isCheckoutStatusRecoveryCode("PAYMENT_IN_PROGRESS")).toBe(true);
    expect(isCheckoutStatusRecoveryCode("SNAPPAY_TOKEN_DUPLICATE")).toBe(true);
    expect(isCheckoutStatusRecoveryCode("CART_EMPTY")).toBe(false);
  });

  it("reads the order id from a 202 finalize body and from a 409 error payload", () => {
    expect(orderIdFromCheckoutFailure({ success: false, orderId: 91 })).toBe(91);
    expect(
      orderIdFromCheckoutFailure({
        errorCode: "PAYMENT_IN_PROGRESS",
        data: { orderId: "111459" },
      }),
    ).toBe(111459);
    expect(
      orderIdFromCheckoutFailure({
        details: { data: { orderId: 77 } },
      }),
    ).toBe(77);
  });

  it("falls back to the stored checkout identity when the payload omits orderId", () => {
    resolveCheckoutAttemptId({
      quoteHash: "sha256:held",
      cartSignature: "1:100000:100:1",
      cartIsEmpty: false,
      gateway: "snappay",
    });
    window.localStorage.setItem("pendingCheckoutOrderId", "88");

    expect(orderIdFromCheckoutFailure({ errorCode: "PAYMENT_UNKNOWN" })).toBe(88);
  });

  it("persists the pending payment ids used by the result page", () => {
    resolveCheckoutAttemptId({
      quoteHash: "sha256:held",
      cartSignature: "1:100000:100:1",
      cartIsEmpty: false,
      gateway: "snappay",
    });

    expect(persistPendingPaymentResult(91, "attempt-91")).toBe("/payment/result?orderId=91");
    expect(window.localStorage.getItem("pendingOrderId")).toBe("91");
    expect(window.localStorage.getItem("pendingCheckoutOrderId")).toBe("91");
    expect(window.localStorage.getItem("pendingPaymentAttemptId")).toBe("attempt-91");
  });
});
