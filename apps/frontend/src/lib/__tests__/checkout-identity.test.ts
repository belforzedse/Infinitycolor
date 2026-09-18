import {
  clearCheckoutIdentity,
  hydrateCheckoutIdentityFromServer,
  persistCheckoutOrder,
  readCheckoutAttemptId,
  readCheckoutIdentity,
  resolveCheckoutAttemptId,
  shouldResumeStoredCheckout,
} from "../checkout-identity";

describe("checkout identity", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("reuses the original attempt when the quote hash is unchanged", () => {
    const first = resolveCheckoutAttemptId({
      quoteHash: "sha256:same",
      cartSignature: "1:100000:100:1",
      cartIsEmpty: false,
      gateway: "snappay",
    });
    const second = resolveCheckoutAttemptId({
      quoteHash: "sha256:same",
      cartSignature: "1:100000:100:1",
      cartIsEmpty: false,
      gateway: "snappay",
    });

    expect(second.attemptId).toBe(first.attemptId);
    expect(second.quoteHash).toBe("sha256:same");
    expect(second.continueExisting).toBe(true);
  });

  it("keeps the original attempt and quote when the mutable cart is emptied", () => {
    const first = resolveCheckoutAttemptId({
      quoteHash: "sha256:original",
      cartSignature: "1:100000:100:1",
      cartIsEmpty: false,
      gateway: "snappay",
    });
    persistCheckoutOrder(111459);

    const emptied = resolveCheckoutAttemptId({
      quoteHash: "sha256:new-empty-quote",
      cartSignature: "0:0:",
      cartIsEmpty: true,
      gateway: "snappay",
    });

    expect(emptied.attemptId).toBe(first.attemptId);
    expect(emptied.quoteHash).toBe("sha256:original");
    expect(emptied.continueExisting).toBe(true);
    expect(readCheckoutAttemptId()).toBe(first.attemptId);
  });

  it("mints a new attempt when the payable quote changes on the same basket", () => {
    const first = resolveCheckoutAttemptId({
      quoteHash: "sha256:original",
      cartSignature: "1:100000:100:1",
      cartIsEmpty: false,
      gateway: "snappay",
    });
    persistCheckoutOrder(111459);

    const discounted = resolveCheckoutAttemptId({
      quoteHash: "sha256:after-discount",
      cartSignature: "1:100000:100:1",
      cartIsEmpty: false,
      gateway: "snappay",
    });

    expect(discounted.attemptId).not.toBe(first.attemptId);
    expect(discounted.quoteHash).toBe("sha256:after-discount");
    expect(discounted.continueExisting).toBe(false);
    expect(window.localStorage.getItem("continuableCheckoutAttemptId")).toBe(first.attemptId);
    expect(window.localStorage.getItem("continuableCheckoutQuoteHash")).toBe("sha256:original");
  });

  it("mints a new attempt when the quote changes before an order exists", () => {
    const first = resolveCheckoutAttemptId({
      quoteHash: "sha256:original",
      cartSignature: "1:100000:100:1",
      cartIsEmpty: false,
      gateway: "mellat",
    });

    const discounted = resolveCheckoutAttemptId({
      quoteHash: "sha256:after-coupon",
      cartSignature: "1:100000:100:1",
      cartIsEmpty: false,
      gateway: "mellat",
    });

    expect(discounted.attemptId).not.toBe(first.attemptId);
    expect(discounted.quoteHash).toBe("sha256:after-coupon");
    expect(discounted.continueExisting).toBe(false);
  });

  it("mints a new attempt for a different non-empty basket and stashes the payable order", () => {
    const first = resolveCheckoutAttemptId({
      quoteHash: "sha256:coat",
      cartSignature: "1:100000:100:1",
      cartIsEmpty: false,
      gateway: "snappay",
    });
    persistCheckoutOrder(111459);

    const next = resolveCheckoutAttemptId({
      quoteHash: "sha256:pullover",
      cartSignature: "2:200000:200:2",
      cartIsEmpty: false,
      gateway: "snappay",
    });

    expect(next.attemptId).not.toBe(first.attemptId);
    expect(next.continueExisting).toBe(false);
    expect(next.quoteHash).toBe("sha256:pullover");
    expect(window.localStorage.getItem("continuableCheckoutOrderId")).toBe("111459");
    expect(window.localStorage.getItem("continuableCheckoutQuoteHash")).toBe("sha256:coat");
    expect(window.localStorage.getItem("continuableCheckoutAttemptId")).toBe(first.attemptId);
  });

  it("mints a new attempt when the selected gateway changes, even if the cart is empty", () => {
    const first = resolveCheckoutAttemptId({
      quoteHash: "sha256:original",
      cartSignature: "1:100000:100:1",
      cartIsEmpty: false,
      gateway: "snappay",
    });
    persistCheckoutOrder(111459);

    const switched = resolveCheckoutAttemptId({
      quoteHash: "sha256:original",
      cartSignature: "0:0:",
      cartIsEmpty: true,
      gateway: "mellat",
    });

    expect(switched.attemptId).not.toBe(first.attemptId);
    expect(switched.continueExisting).toBe(false);
    expect(window.localStorage.getItem("continuableCheckoutAttemptId")).toBe(first.attemptId);
    expect(window.localStorage.getItem("continuableCheckoutGateway")).toBe("snappay");
  });

  it("restores the stashed unpaid checkout when the shopper returns to that gateway", () => {
    const first = resolveCheckoutAttemptId({
      quoteHash: "sha256:original",
      cartSignature: "1:100000:100:1",
      cartIsEmpty: false,
      gateway: "snappay",
    });
    persistCheckoutOrder(111459);
    resolveCheckoutAttemptId({
      quoteHash: "sha256:card",
      cartSignature: "1:100000:100:1",
      cartIsEmpty: false,
      gateway: "mellat",
    });

    const restored = resolveCheckoutAttemptId({
      quoteHash: "sha256:original",
      cartSignature: "1:100000:100:1",
      cartIsEmpty: false,
      gateway: "snappay",
    });

    expect(restored.attemptId).toBe(first.attemptId);
    expect(restored.continueExisting).toBe(true);
    expect(restored.gateway).toBe("snappay");
    expect(readCheckoutAttemptId()).toBe(first.attemptId);
  });

  it("clears stored identity", () => {
    resolveCheckoutAttemptId({
      quoteHash: "sha256:x",
      cartSignature: "sig",
      cartIsEmpty: false,
    });
    clearCheckoutIdentity();
    expect(readCheckoutIdentity()).toBeNull();
  });

  it("continues an empty-cart unpaid checkout unless a different selectable gateway is chosen", () => {
    const stored = {
      attemptId: "attempt-111459",
      quoteHash: "sha256:original",
      gateway: "snappay",
      orderId: "111459",
    };
    const live = {
      attemptId: "attempt-111459",
      quoteHash: "sha256:original",
      gateway: "snappay",
      orderId: 111459,
    };
    expect(
      shouldResumeStoredCheckout({
        stored,
        selectedGateway: "samankish",
        selectableGateways: ["samankish"],
        cartIsEmpty: true,
        resumableCheckout: live,
      }),
    ).toBe(true);
    expect(
      shouldResumeStoredCheckout({
        stored,
        selectedGateway: "mellat",
        selectableGateways: ["snappay", "mellat"],
        cartIsEmpty: true,
        resumableCheckout: live,
      }),
    ).toBe(false);
    expect(
      shouldResumeStoredCheckout({
        stored,
        selectedGateway: "snappay",
        selectableGateways: ["snappay", "mellat"],
        cartIsEmpty: true,
        resumableCheckout: live,
      }),
    ).toBe(true);
    expect(
      shouldResumeStoredCheckout({
        stored,
        selectedGateway: "snappay",
        selectableGateways: ["snappay", "mellat"],
        cartIsEmpty: true,
      }),
    ).toBe(false);
    expect(
      shouldResumeStoredCheckout({
        stored,
        selectedGateway: "snappay",
        selectableGateways: ["snappay", "mellat"],
        cartIsEmpty: true,
        resumableCheckout: { ...live, quoteHash: "sha256:other" },
      }),
    ).toBe(false);
  });

  it("hydrates identity from a server-confirmed live hold", () => {
    hydrateCheckoutIdentityFromServer({
      attemptId: "attempt-live",
      quoteHash: "sha256:original",
      orderId: 111459,
      gateway: "mellat",
    });

    expect(readCheckoutIdentity()).toEqual({
      attemptId: "attempt-live",
      quoteHash: "sha256:original",
      orderId: "111459",
      gateway: "mellat",
    });
  });
});
