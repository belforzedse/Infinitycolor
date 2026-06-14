import { expect, test } from "@playwright/test";
import { E2E_PRODUCT_TITLE } from "../../fixtures/storefront";
import { prepareStorefrontPage } from "../../helpers/page";
import {
  addSeededProductToCart,
  cartItemByTitle,
  readCartSummaryTotal,
} from "../../helpers/cart";

test.describe("guest cart totals and quantity", () => {
  test("@regression cart total scales with quantity and recovers after decrease", async ({
    page,
  }) => {
    await prepareStorefrontPage(page);

    await addSeededProductToCart(page);
    await page.goto("/cart");

    const item = cartItemByTitle(page, E2E_PRODUCT_TITLE);
    await expect(item).toBeVisible({ timeout: 15_000 });

    const totalAtOne = await readCartSummaryTotal(page);
    expect(totalAtOne).toBeGreaterThan(0);

    // Increase to two and confirm the payable total doubles.
    await item.getByTestId("cart-quantity-increase").click();
    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("cart") || "[]")[0]?.quantity))
      .toBe(2);
    await expect.poll(() => readCartSummaryTotal(page)).toBe(totalAtOne * 2);

    // Decrease back to one and confirm the total recovers.
    await item.getByTestId("cart-quantity-decrease").click();
    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("cart") || "[]")[0]?.quantity))
      .toBe(1);
    await expect.poll(() => readCartSummaryTotal(page)).toBe(totalAtOne);

    // The local dev DB can render unrelated product images with empty src values on cart-adjacent
    // surfaces. Keep this regression scoped to the seeded cart behavior.
  });

  test("@regression removing the only cart item empties the cart", async ({ page }) => {
    await prepareStorefrontPage(page);

    await addSeededProductToCart(page);
    await page.goto("/cart");

    const item = cartItemByTitle(page, E2E_PRODUCT_TITLE);
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.getByTestId("cart-item-remove").click();

    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("cart") || "[]").length))
      .toBe(0);

    // The local dev DB can render unrelated product images with empty src values on cart-adjacent
    // surfaces. Keep this regression scoped to the seeded cart behavior.
  });
});
