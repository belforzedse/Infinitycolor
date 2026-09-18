import {
  claimPaymentAttemptForInitiation,
  claimPaymentAttemptForSnappayInitiation,
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

  it("leases a live SnappPay attempt so two tabs cannot mint a second token", async () => {
    const raw = jest.fn().mockResolvedValue({ rows: [{ id: 17, lease_version: 3 }] });
    const strapi = { db: { connection: { raw } } } as any;

    await expect(claimPaymentAttemptForSnappayInitiation(strapi, 17)).resolves.toEqual({
      leaseVersion: 3,
    });
    expect(raw).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('Created', 'Pending', 'Redirected', 'Unknown', 'Failed', 'Cancelled', 'Expired')"),
      expect.arrayContaining([17]),
    );
    expect(raw.mock.calls[0][0]).toContain("provider_response->'pendingDispatch' IS NULL");
  });

  it("does not treat a mint lease without a returned version as acquired", async () => {
    const strapi = {
      db: { connection: { raw: jest.fn().mockResolvedValue({ rows: [{ id: 17 }] }) } },
    } as any;

    await expect(claimPaymentAttemptForSnappayInitiation(strapi, 17)).resolves.toBeNull();
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

  it("never leaks an internal reconciliation label as the shopper-facing errorCode", () => {
    // A replay caught mid-reconciliation carries an internal failureCode
    // (SNAPPAY_RECONCILIATION_PENDING) that the storefront's error-code switch
    // has no case for -- it fell through to the generic banner instead of the
    // already-mapped PAYMENT_IN_PROGRESS message. See checkout.error Sentry issue.
    expect(paymentAttemptResponse({
      attemptId: "attempt-17",
      Status: "Unknown",
      failureCode: "SNAPPAY_RECONCILIATION_PENDING",
      failureMessage: "Automatic reconciliation exhausted: ...",
    })).toEqual(expect.objectContaining({
      success: false,
      paymentStatus: "Unknown",
      errorCode: "PAYMENT_IN_PROGRESS",
      message: "پرداخت قبلی هنوز در حال بررسی است",
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
