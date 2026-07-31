import {
  claimPaymentAttemptForInitiation,
  paymentAttemptResponse,
  reconcileOrderPaymentAttempt,
} from "../services/payment-attempt";

describe("payment attempt initiation", () => {
  it("uses a compare-and-set so exactly one caller may initiate a provider payment", async () => {
    const raw = jest.fn().mockResolvedValue({ rows: [{ id: 17 }] });
    const strapi = { db: { connection: { raw } } } as any;

    await expect(claimPaymentAttemptForInitiation(strapi, 17)).resolves.toBe(true);
    expect(raw).toHaveBeenCalledWith(
      expect.stringContaining("WHERE id = ? AND status = 'Created'"),
      [expect.any(Date), 17],
    );
  });

  it("denies a second provider initiation after the attempt was already claimed", async () => {
    const strapi = {
      db: { connection: { raw: jest.fn().mockResolvedValue({ rows: [] }) } },
    } as any;

    await expect(claimPaymentAttemptForInitiation(strapi, 17)).resolves.toBe(false);
  });

  it("does not present an in-progress attempt as a completed checkout", () => {
    expect(paymentAttemptResponse({
      attemptId: "attempt-17",
      Status: "Pending",
      order: { id: 31 },
    })).toEqual(expect.objectContaining({
      success: false,
      paymentStatus: "Pending",
      errorCode: "PAYMENT_IN_PROGRESS",
      orderId: 31,
    }));
  });

  it("replays the provider redirect only after initiation completed", () => {
    expect(paymentAttemptResponse({
      attemptId: "attempt-17",
      Status: "Redirected",
      redirectUrl: "https://bank.example/start",
      providerReference: "provider-ref",
    })).toEqual(expect.objectContaining({
      success: true,
      paymentStatus: "Redirected",
      redirectUrl: "https://bank.example/start",
      refId: "provider-ref",
    }));
  });

  it("never infers a SnappPay settlement from legacy order status", async () => {
    const update = jest.fn();
    const attempt = {
      id: 17,
      attemptId: "attempt-17",
      Gateway: "SnappPay",
      Status: "Pending",
    };
    const strapi = {
      db: {
        query: jest.fn(() => ({
          findOne: jest.fn().mockResolvedValue(attempt),
          update,
        })),
      },
    } as any;

    await expect(
      reconcileOrderPaymentAttempt(strapi, {
        id: 31,
        Status: "Started",
      }),
    ).resolves.toBe(attempt);
    expect(update).not.toHaveBeenCalled();
  });
});
