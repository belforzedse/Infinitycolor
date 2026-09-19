import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import {
  getTopupOptions,
  getTopupStatus,
  getWalletAvailability,
  getWalletTransactions,
} from "../../helpers/api";
import { deliverProviderCallback, startTopupFromWalletPage } from "../../helpers/wallet";

/**
 * Adding money to the wallet, end to end through a real server settlement.
 *
 * ZarinPal runs in its deterministic mode here, which answers verification for
 * an `E2E-` authority it minted itself and only for the amount it minted it
 * for. That is a simulation of the provider, never evidence about a live
 * merchant contract — a real authority is still sent to the real gateway even
 * while simulating.
 */
test.describe("wallet top-up", () => {
  test.use({ storageState: authStorageStatePath("customer") });

  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Provider redirect coverage is desktop-only.",
    );
    const options = await getTopupOptions(request);
    testInfo.skip(
      options.enabled !== true ||
        !(options.gateways ?? []).some((gateway) => gateway.code.toLowerCase() === "zarinpal"),
      "Top-ups are off, or ZarinPal is not among the offered gateways on this target.",
    );
  });

  test("@payment credits the wallet exactly once for a completed top-up", async ({
    page,
    request,
  }) => {
    const amountToman = 50_000;
    const before = await getWalletAvailability(request);
    const ledgerBefore = await getWalletTransactions(request);

    const started = await startTopupFromWalletPage(page, amountToman);

    // Nothing has moved yet: an intent is not money.
    const pending = await getWalletAvailability(request);
    expect(pending.balanceIrr).toBe(before.balanceIrr);
    expect((await getTopupStatus(request, started.saleOrderId)).status).not.toBe("Success");

    const callback = await deliverProviderCallback(request, "/api/wallet/payment-callback", {
      Authority: started.authority,
      Status: "OK",
    });
    expect([301, 302, 303, 307, 308]).toContain(callback.status());

    await expect
      .poll(async () => (await getTopupStatus(request, started.saleOrderId)).status, {
        timeout: 30_000,
      })
      .toBe("Success");

    const after = await getWalletAvailability(request);
    expect(after.balanceIrr).toBe(before.balanceIrr + amountToman * 10);
    // A top-up is spendable immediately; it is not held by anything.
    expect(after.availableIrr).toBe(before.availableIrr + amountToman * 10);

    // Exactly one ledger row, not merely a balance that happens to be right.
    const ledgerAfter = await getWalletTransactions(request);
    expect(ledgerAfter.length).toBe(ledgerBefore.length + 1);
  });

  test("@payment does not credit a second time when the callback is replayed", async ({
    page,
    request,
  }) => {
    const amountToman = 30_000;
    const started = await startTopupFromWalletPage(page, amountToman);

    await deliverProviderCallback(request, "/api/wallet/payment-callback", {
      Authority: started.authority,
      Status: "OK",
    });
    await expect
      .poll(async () => (await getTopupStatus(request, started.saleOrderId)).status, {
        timeout: 30_000,
      })
      .toBe("Success");

    const afterFirst = await getWalletAvailability(request);
    const ledgerAfterFirst = await getWalletTransactions(request);

    // A customer refreshing the return page, or a provider retrying, replays
    // the same callback. The ledger's uniqueness constraint is what makes the
    // second one a no-op rather than a second credit.
    for (let replay = 0; replay < 2; replay += 1) {
      await deliverProviderCallback(request, "/api/wallet/payment-callback", {
        Authority: started.authority,
        Status: "OK",
      });
    }

    const afterReplays = await getWalletAvailability(request);
    expect(afterReplays.balanceIrr).toBe(afterFirst.balanceIrr);
    expect((await getWalletTransactions(request)).length).toBe(ledgerAfterFirst.length);
  });

  test("@payment leaves the balance untouched when the customer abandons the gateway", async ({
    page,
    request,
  }) => {
    const before = await getWalletAvailability(request);
    const started = await startTopupFromWalletPage(page, 40_000);

    // ZarinPal reports a cancelled payment as a non-OK status on the return.
    await deliverProviderCallback(request, "/api/wallet/payment-callback", {
      Authority: started.authority,
      Status: "NOK",
    });

    const after = await getWalletAvailability(request);
    expect(after.balanceIrr).toBe(before.balanceIrr);
    expect((await getTopupStatus(request, started.saleOrderId)).status).not.toBe("Success");
  });

  test("@payment refuses a forged authority without touching the balance", async ({ request }) => {
    const before = await getWalletAvailability(request);

    // An authority the store never minted correlates to no intent at all, so
    // there is nothing to credit and nothing to look up at the provider.
    const callback = await deliverProviderCallback(request, "/api/wallet/payment-callback", {
      Authority: "E2E-999999-999999999-forged",
      Status: "OK",
    });
    expect(callback.status()).toBeLessThan(500);

    const after = await getWalletAvailability(request);
    expect(after.balanceIrr).toBe(before.balanceIrr);
  });
});
