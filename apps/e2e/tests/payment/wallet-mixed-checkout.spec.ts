import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import {
  clearCart,
  findProductVariationBySku,
  getPaymentStatus,
  getProductVariationStock,
  getWalletAvailability,
  resetCartToVariation,
} from "../../helpers/api";
import {
  selectFirstShipping,
  selectSeededAddress,
  acceptCheckoutTerms,
  selectZarinpalGateway,
} from "../../helpers/checkout";
import { settleOnZarinpalSandbox, useWalletAtCheckout } from "../../helpers/wallet";

/**
 * Paying part of an order from wallet credit and the rest through a bank.
 *
 * The wallet leg is *held* at checkout and only captured when the bank leg
 * settles, so the assertions here are about three things moving together: the
 * balance, the hold, and the order. ZarinPal's own sandbox carries the bank
 * leg, so the redirect, the return and the verification are the real protocol.
 */
test.describe("mixed wallet + gateway checkout", () => {
  test.use({ storageState: authStorageStatePath("customer") });

  test.beforeEach(async ({ request }, testInfo) => {
    testInfo.skip(
      testInfo.project.name.includes("mobile"),
      "Provider redirect coverage is desktop-only.",
    );
    await clearCart(request, "customer");
    const wallet = await getWalletAvailability(request);
    testInfo.skip(
      wallet.availableIrr <= 0,
      "This customer has no spendable credit on this target; top up first.",
    );
  });

  test("@payment holds the wallet leg, charges the bank the rest, and captures once", async ({
    page,
    request,
  }) => {
    const variation = await findProductVariationBySku(request);
    const stockBefore = await getProductVariationStock(request, variation.id);
    const before = await getWalletAvailability(request);
    await resetCartToVariation(request, variation.id, 1, "customer");

    await page.goto("/checkout", { waitUntil: "domcontentloaded" });
    await selectSeededAddress(page);
    await selectFirstShipping(page);

    const split = await useWalletAtCheckout(page);
    // A mixed order is only interesting when both legs are non-zero.
    test.skip(
      split.gatewayToman <= 0,
      "Credit covers the whole order on this target; wallet-only is covered elsewhere.",
    );
    expect(split.walletToman).toBeGreaterThan(0);

    await selectZarinpalGateway(page);
    await acceptCheckoutTerms(page);

    const finalizePromise = page.waitForResponse(
      (response) =>
        /\/api\/carts\/finalize(?:\?.*)?$/i.test(response.url()) &&
        response.request().method() === "POST",
      { timeout: 60_000 },
    );
    await page.getByTestId("checkout-submit").click();
    const finalize = await finalizePromise;
    expect(
      finalize.ok(),
      `mixed checkout failed with ${finalize.status()}: ${await finalize.text()}`,
    ).toBe(true);
    const finalizeBody = (await finalize.json()) as any;
    const orderId = Number(finalizeBody?.data?.orderId ?? finalizeBody?.orderId);
    expect(orderId).toBeGreaterThan(0);

    // Held, not spent: the balance has not moved, but the credit is committed.
    const held = await getWalletAvailability(request);
    expect(held.balanceIrr).toBe(before.balanceIrr);
    expect(held.heldIrr).toBe(before.heldIrr + split.walletToman * 10);
    expect(held.availableIrr).toBe(before.availableIrr - split.walletToman * 10);

    await settleOnZarinpalSandbox(page, "pay");
    await expect(page).toHaveURL(new RegExp(`/payment/result\\?.*orderId=${orderId}`), {
      timeout: 60_000,
    });

    await expect
      .poll(async () => (await getPaymentStatus(request, "customer", orderId))?.isPaid, {
        timeout: 60_000,
      })
      .toBe(true);

    // Captured: the balance falls by the wallet leg only, and nothing stays held.
    const after = await getWalletAvailability(request);
    expect(after.balanceIrr).toBe(before.balanceIrr - split.walletToman * 10);
    expect(after.heldIrr).toBe(before.heldIrr);

    // The bank carried the remainder, so stock is consumed exactly once.
    expect(await getProductVariationStock(request, variation.id)).toBe(stockBefore - 1);
  });

  test("@payment gives the held credit back when the bank payment is cancelled", async ({
    page,
    request,
  }) => {
    const variation = await findProductVariationBySku(request);
    const before = await getWalletAvailability(request);
    await resetCartToVariation(request, variation.id, 1, "customer");

    await page.goto("/checkout", { waitUntil: "domcontentloaded" });
    await selectSeededAddress(page);
    await selectFirstShipping(page);

    const split = await useWalletAtCheckout(page);
    test.skip(split.gatewayToman <= 0, "Credit covers the whole order on this target.");

    await selectZarinpalGateway(page);
    await acceptCheckoutTerms(page);

    const finalizePromise = page.waitForResponse(
      (response) =>
        /\/api\/carts\/finalize(?:\?.*)?$/i.test(response.url()) &&
        response.request().method() === "POST",
      { timeout: 60_000 },
    );
    await page.getByTestId("checkout-submit").click();
    const finalize = await finalizePromise;
    const orderId = Number(
      ((await finalize.json()) as any)?.data?.orderId ??
        ((await finalize.json()) as any)?.orderId,
    );

    await settleOnZarinpalSandbox(page, "cancel");

    // Abandoning at the bank must return the credit, not spend it. The hold's
    // lifetime is the stock reservation's, so both come back together.
    await expect
      .poll(async () => (await getWalletAvailability(request)).heldIrr, { timeout: 60_000 })
      .toBe(before.heldIrr);
    const after = await getWalletAvailability(request);
    expect(after.balanceIrr).toBe(before.balanceIrr);
    expect(after.availableIrr).toBe(before.availableIrr);

    if (Number.isFinite(orderId) && orderId > 0) {
      expect((await getPaymentStatus(request, "customer", orderId))?.isPaid).toBe(false);
    }
  });
});
