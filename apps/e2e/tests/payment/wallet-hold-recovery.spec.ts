import { expect, test } from "@playwright/test";
import { authStorageStatePath } from "../../helpers/auth";
import { getWalletAvailability } from "../../helpers/api";

/**
 * The customer-visible contract of automatic wallet-hold recovery.
 *
 * The promise this feature makes is narrow and testable: wallet credit
 * committed to a payment that never completes becomes spendable again *without
 * the shopper doing anything*, and while it is held every surface that shows a
 * balance says so and says by when.
 *
 * SnappPay cannot be driven from CI — a real installment checkout needs a real
 * shopper with a real credit line — so the provider half is covered by the
 * backend's deterministic `SNAPPAY_E2E_STATUS_SCRIPT` fixture and its unit and
 * integration suites. What only a browser can prove is what the shopper is
 * actually told, which is what this file asserts.
 */
test.describe("wallet credit held by an unfinished payment", () => {
  test.use({ storageState: authStorageStatePath("customer") });

  test("@payment the wallet page reports spendable credit, not the posted balance", async ({
    page,
    request,
  }) => {
    const wallet = await getWalletAvailability(request);

    await page.goto("/wallet");
    await expect(page.getByText("کیف پول اینفینیتی")).toBeVisible();

    const spendableToman = Math.round(wallet.availableIrr / 10).toLocaleString();
    await expect(page.getByText(`${spendableToman} تومان`).first()).toBeVisible();

    if (wallet.heldIrr > 0) {
      // Held credit must be explained wherever it is missing from the headline
      // figure. Silence here is the whole defect: the balance simply looks
      // smaller and nothing accounts for the difference.
      const notice = page.getByTestId("wallet-held-notice");
      await expect(notice).toBeVisible();
      await expect(notice).toContainText("رزرو شده");
      await expect(notice).toContainText("به‌طور خودکار آزاد می‌شود");
    } else {
      await expect(page.getByTestId("wallet-held-notice")).toHaveCount(0);
    }
  });

  test("@payment every live hold carries an upper bound on how long it can last", async ({
    request,
  }) => {
    const wallet = await getWalletAvailability(request);
    test.skip(wallet.holds.length === 0, "This customer has no live wallet hold on this target.");

    for (const hold of wallet.holds) {
      expect(hold.amountIrr, "a hold with no amount is not a hold").toBeGreaterThan(0);
      expect(
        ["reconciling", "awaiting_provider", "reclaimable", "releasing"],
        "the storefront needs a state it knows how to describe",
      ).toContain(hold.state);
      // "It comes back on its own" is only reassuring if the page can say by
      // when, so the bound is part of the contract, not a nicety.
      expect(hold.boundAt, "a hold must state when it expires at the latest").toBeTruthy();
      expect(new Date(hold.boundAt as string).getTime()).toBeGreaterThan(Date.now() - 60_000);
    }

    const heldSum = wallet.holds.reduce((total, hold) => total + hold.amountIrr, 0);
    expect(heldSum, "held balance must equal the sum of the live holds").toBe(wallet.heldIrr);
  });
});
