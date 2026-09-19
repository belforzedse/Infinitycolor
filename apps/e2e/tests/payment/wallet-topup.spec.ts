import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import {
  getTopupOptions,
  getTopupStatus,
  getWalletAvailability,
  getWalletTransactions,
} from "../../helpers/api";
import {
  deliverProviderCallback,
  settleOnZarinpalSandbox,
  startTopupFromWalletPage,
} from "../../helpers/wallet";

/**
 * Adding money to the wallet, end to end through a real server settlement.
 *
 * This drives ZarinPal's own sandbox: a real authority, a real pay page, a real
 * redirect back to our callback, and a real server-to-server verify. Nothing
 * about the provider protocol is stubbed, which is the point — the wallet's
 * money moves entirely on the server, so a browser-level stub of the verify
 * call would assert nothing about whether it moved.
 *
 * It is a sandbox with a test merchant, so it is evidence about the protocol
 * and about our handling of it, and no evidence at all about a live merchant
 * contract.
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

    await settleOnZarinpalSandbox(page, "pay");
    // The sandbox sends the browser back to our callback, which verifies with
    // ZarinPal before it credits anything.
    await expect(page).toHaveURL(/\/wallet\b/i, { timeout: 60_000 });

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

    await settleOnZarinpalSandbox(page, "pay");
    await expect
      .poll(async () => (await getTopupStatus(request, started.saleOrderId)).status, {
        timeout: 60_000,
      })
      .toBe("Success");

    const afterFirst = await getWalletAvailability(request);
    const ledgerAfterFirst = await getWalletTransactions(request);

    // A customer refreshing the return page, or a provider retrying, replays
    // the same callback. ZarinPal answers the second verify with code 101
    // ("Verified") rather than 100, and the ledger's uniqueness constraint is
    // what makes it a no-op rather than a second credit.
    for (let replay = 0; replay < 2; replay += 1) {
      const response = await deliverProviderCallback(
        request,
        "/api/wallet/payment-callback",
        { Authority: started.authority, Status: "OK" },
      );
      expect(response.status(), "a replayed callback must not error").toBeLessThan(500);
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

    // Cancelling on the sandbox sends the browser back with a non-OK status.
    await settleOnZarinpalSandbox(page, "cancel");
    await expect(page).toHaveURL(/\/wallet\b/i, { timeout: 60_000 });

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
