import { snappayCallbackHandler } from "../controllers/helpers/snappayCallback";

describe("snappayCallbackHandler", () => {
  it("forwards only the documented POST fields plus the correlation nonce", async () => {
    const acceptCallback = jest.fn().mockResolvedValue({
      accepted: true,
      redirectUrl:
        "https://storefront.test.invalid/payment/result?resultHint=processing",
    });
    const strapi = {
      service: jest.fn().mockReturnValue({ acceptCallback }),
    } as any;
    const ctx = {
      request: {
        body: {
          transactionId: "ABC1234567",
          state: "ok",
          amount: "1200000",
          paymentToken: "must-not-be-forwarded",
          OrderId: "must-not-be-forwarded",
        },
        query: { nonce: "abcdefghijklmnopqrstuv" },
      },
      redirect: jest.fn(),
      status: 0,
    } as any;

    await snappayCallbackHandler(strapi, ctx);

    expect(acceptCallback).toHaveBeenCalledWith({
      transactionId: "ABC1234567",
      state: "OK",
      amount: 1_200_000,
      nonce: "abcdefghijklmnopqrstuv",
    });
    expect(acceptCallback.mock.calls[0][0]).not.toHaveProperty(
      "paymentToken",
    );
    expect(acceptCallback.mock.calls[0][0]).not.toHaveProperty("OrderId");
    expect(ctx.redirect).toHaveBeenCalledWith(
      "https://storefront.test.invalid/payment/result?resultHint=processing",
    );
    expect(ctx.status).toBe(303);
  });

  it.each(["", "12.5", "-1", "9007199254740992"])(
    "normalizes invalid callback amount %p to a rejected value",
    async (amount) => {
      const acceptCallback = jest.fn().mockResolvedValue({
        accepted: false,
        redirectUrl:
          "https://storefront.test.invalid/payment/result?resultHint=invalid_callback",
      });
      const strapi = {
        service: jest.fn().mockReturnValue({ acceptCallback }),
      } as any;
      const ctx = {
        request: {
          body: {
            transactionId: "ABC1234567",
            state: "OK",
            amount,
          },
          query: { nonce: "abcdefghijklmnopqrstuv" },
        },
        redirect: jest.fn(),
      } as any;

      await snappayCallbackHandler(strapi, ctx);

      expect(acceptCallback).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 0 }),
      );
      expect(ctx.status).toBe(303);
    },
  );
});
