import customRouter from "../routes/custom-router";

describe("order payment callback routes", () => {
  it("exposes a dedicated public POST-only SnappPay callback", () => {
    expect(customRouter.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          path: "/orders/snappay/callback",
          handler: "order.snappayCallback",
          config: expect.objectContaining({ auth: false }),
        }),
      ]),
    );
    expect(customRouter.routes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "GET",
          path: "/orders/snappay/callback",
        }),
      ]),
    );
  });

  it("exposes the ZarinPal browser callback as a public GET route", () => {
    expect(customRouter.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "GET",
          path: "/orders/payment-callback",
          handler: "order.verifyPayment",
          config: expect.objectContaining({ auth: false }),
        }),
      ]),
    );
  });

  it("keeps the payment callback POST route public for bank callbacks", () => {
    expect(customRouter.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          path: "/orders/payment-callback",
          handler: "order.verifyPayment",
          config: expect.objectContaining({ auth: false }),
        }),
      ]),
    );
  });
});
