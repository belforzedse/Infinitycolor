import { decideSnappayRecovery } from "../services/snappay-state-machine";
import { requestProviderHoldRelease } from "../../cart/services/lib/checkout-supersede";

/**
 * A shopper who opened SnappPay with a wallet split and came back without
 * paying must be able to spend that credit again.
 *
 * `isSupersedableHoldRow` refuses to reclaim a SnappPay hold inline and always
 * will, so the release goes through the queue: the shopper's claim is recorded
 * on a RECONCILE operation, the worker reads `GET /status`, and only then does a
 * revert cancel the order — which is what releases the reservation, and with it
 * the hold. These tests pin the two halves of that: what the claim is allowed to
 * decide, and who is allowed to make it.
 */
describe("customer abandonment of a SnappPay checkout", () => {
  describe("what the shopper's claim may decide", () => {
    it("reverts a token the provider still reports as uncommitted", () => {
      // The 64% of abandonments where status answers 200/REGISTERED. Without the
      // claim these only reconcile — 5m, 40m, 3h — while the wallet stays held
      // until the 1.5h reservation defer ceiling.
      expect(
        decideSnappayRecovery({ providerStatus: "REGISTERED", customerAbandoned: true }),
      ).toBe("REVERT");
      expect(
        decideSnappayRecovery({ providerStatus: "PENDING", customerAbandoned: true }),
      ).toBe("REVERT");
    });

    it("never overrides provider evidence that the payment happened", () => {
      // The shopper knows what their browser did; they do not know what SnappPay
      // recorded. A shopper who pays and then clicks "I didn't pay" keeps their
      // order rather than having a settled payment thrown away.
      expect(
        decideSnappayRecovery({ providerStatus: "SETTLE", customerAbandoned: true }),
      ).toBe("FINALIZE_LOCAL");
      expect(
        decideSnappayRecovery({ providerStatus: "VERIFY", customerAbandoned: true }),
      ).toBe("SETTLE");
    });

    it("is void once the shopper's own browser came back OK", () => {
      // The `OK` callback is this same shopper saying the payment succeeded, and
      // the provider's status legitimately lags it — which is why `OK` + 1007
      // goes to verify. A token still reading PENDING/REGISTERED behind an OK
      // return must be recovered, never reverted, or a real payment is thrown
      // away. Both orderings land here: the callback and the claim share one
      // reconcile operation, so the callback can arrive after the claim.
      expect(
        decideSnappayRecovery({
          providerStatus: "PENDING",
          callbackState: "OK",
          customerAbandoned: true,
        }),
      ).toBe("VERIFY");
      expect(
        decideSnappayRecovery({
          providerStatus: "REGISTERED",
          callbackState: "OK",
          customerAbandoned: true,
        }),
      ).toBe("RECONCILE");
    });

    it("decides an OK callback identically with and without the claim", () => {
      for (const providerStatus of ["PENDING", "REGISTERED", "VERIFY", "SETTLE", "garbage"]) {
        expect(
          decideSnappayRecovery({ providerStatus, callbackState: "OK", customerAbandoned: true }),
        ).toBe(decideSnappayRecovery({ providerStatus, callbackState: "OK" }));
      }
    });

    it("keeps reconciling a provider state it could not read", () => {
      // UNKNOWN is "we could not observe the provider at all". A claim is not a
      // substitute for an answer, so nothing is cancelled on the strength of it.
      expect(
        decideSnappayRecovery({ providerStatus: "garbage", customerAbandoned: true }),
      ).toBe("RECONCILE");
    });

    it("still parks 1007 and 1048 for review", () => {
      // 1007 NOT_FOUND is the other big share of abandonments, and it remains
      // investigation rather than a licence to cancel: the reservation-expiry
      // job releases a parked attempt's stock and hold on its own schedule.
      expect(decideSnappayRecovery({ providerCode: 1007, customerAbandoned: true })).toBe(
        "MANUAL_REVIEW",
      );
      expect(decideSnappayRecovery({ providerCode: 1048, customerAbandoned: true })).toBe(
        "MANUAL_REVIEW",
      );
    });

    it("leaves every decision unchanged without the claim", () => {
      expect(decideSnappayRecovery({ providerStatus: "REGISTERED" })).toBe("RECONCILE");
      expect(decideSnappayRecovery({ providerStatus: "PENDING" })).toBe("VERIFY");
      expect(
        decideSnappayRecovery({ providerStatus: "REGISTERED", customerAbandoned: false }),
      ).toBe("RECONCILE");
    });
  });

  describe("who may make the claim from the checkout path", () => {
    const attemptRow = (overrides: Record<string, unknown> = {}) => ({
      rows: [
        {
          gateway: "snappay",
          wallet_hold_status: "Active",
          order_id: 4242,
          ...overrides,
        },
      ],
    });

    const strapiWith = (raw: jest.Mock, abandonOrder = jest.fn()) =>
      ({
        db: { connection: { raw } },
        service: jest.fn().mockReturnValue({ abandonOrder }),
        log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
      }) as any;

    it("queues the abandonment for the owner's live SnappPay hold", async () => {
      const raw = jest.fn().mockResolvedValue(attemptRow());
      const abandonOrder = jest.fn().mockResolvedValue({ accepted: true });
      const strapi = strapiWith(raw, abandonOrder);

      await expect(requestProviderHoldRelease(strapi, 7, "attempt-1")).resolves.toBe(true);

      // Ownership is part of the lookup, not a check after it: another
      // customer's attempt id simply does not select a row.
      expect(raw.mock.calls[0][1]).toEqual(["attempt-1", 7]);
      expect(abandonOrder).toHaveBeenCalledWith(4242, "customer_replaced_checkout");
    });

    it("refuses an attempt that is not this customer's", async () => {
      const raw = jest.fn().mockResolvedValue({ rows: [] });
      const abandonOrder = jest.fn();

      await expect(
        requestProviderHoldRelease(strapiWith(raw, abandonOrder), 7, "someone-elses"),
      ).resolves.toBe(false);
      expect(abandonOrder).not.toHaveBeenCalled();
    });

    it("refuses a gateway whose hold is already reclaimable inline", async () => {
      // Mellat and friends are released by `supersedeCheckoutAttempt` in the
      // same transaction. Queueing a SnappPay operation for them would address
      // an attempt the orchestrator does not own.
      const raw = jest.fn().mockResolvedValue(attemptRow({ gateway: "mellat" }));
      const abandonOrder = jest.fn();

      await expect(
        requestProviderHoldRelease(strapiWith(raw, abandonOrder), 7, "attempt-1"),
      ).resolves.toBe(false);
      expect(abandonOrder).not.toHaveBeenCalled();
    });

    it.each(["Captured", "Released", "None", null])(
      "refuses an attempt whose hold is %s rather than Active",
      async (walletHoldStatus) => {
        const raw = jest
          .fn()
          .mockResolvedValue(attemptRow({ wallet_hold_status: walletHoldStatus }));
        const abandonOrder = jest.fn();

        await expect(
          requestProviderHoldRelease(strapiWith(raw, abandonOrder), 7, "attempt-1"),
        ).resolves.toBe(false);
        expect(abandonOrder).not.toHaveBeenCalled();
      },
    );

    it("refuses an attempt that never reached an order", async () => {
      const raw = jest.fn().mockResolvedValue(attemptRow({ order_id: null }));
      const abandonOrder = jest.fn();

      await expect(
        requestProviderHoldRelease(strapiWith(raw, abandonOrder), 7, "attempt-1"),
      ).resolves.toBe(false);
      expect(abandonOrder).not.toHaveBeenCalled();
    });

    it("reports a refused claim rather than promising credit back", async () => {
      // The orchestrator drops the claim when the predecessor's own `OK` return
      // already landed. No release is coming, so the checkout path must not tell
      // the shopper to wait for one.
      const raw = jest.fn().mockResolvedValue(attemptRow());
      const abandonOrder = jest.fn().mockResolvedValue({ accepted: false });

      await expect(
        requestProviderHoldRelease(strapiWith(raw, abandonOrder), 7, "attempt-1"),
      ).resolves.toBe(false);
      expect(abandonOrder).toHaveBeenCalled();
    });

    it("reports a queue failure rather than promising credit back", async () => {
      // The replacement checkout is refused for held funds either way; this only
      // decides whether the shopper is told to retry or to go inspect the old
      // payment. Promising a release that was never queued is the worse answer.
      const raw = jest.fn().mockResolvedValue(attemptRow());
      const abandonOrder = jest.fn().mockRejectedValue(new Error("queue down"));
      const strapi = strapiWith(raw, abandonOrder);

      await expect(requestProviderHoldRelease(strapi, 7, "attempt-1")).resolves.toBe(false);
      expect(strapi.log.error).toHaveBeenCalled();
    });

    it("ignores a blank attempt id without touching the database", async () => {
      const raw = jest.fn();
      await expect(requestProviderHoldRelease(strapiWith(raw), 7, "   ")).resolves.toBe(
        false,
      );
      expect(raw).not.toHaveBeenCalled();
    });
  });
});
