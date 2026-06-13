import { expect, type Page } from "@playwright/test";
import { E2E_PRODUCT_SLUG } from "../fixtures/storefront";

/**
 * Open the seeded product PDP and add it to the cart. Waits for the cart action
 * to report ready so we never click before client hydration finishes.
 */
export async function addSeededProductToCart(page: Page, slug: string = E2E_PRODUCT_SLUG) {
  await page.goto(`/pdp/${slug}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("pdp-cart-action")).toHaveAttribute("data-cart-ready", "true", {
    timeout: 30_000,
  });
  const addButton = page.getByTestId("pdp-add-to-cart");
  await expect(addButton).toBeEnabled({ timeout: 30_000 });
  await addButton.click();
}

/** Read the numeric "قابل پرداخت" total exposed by the cart summary card. */
export async function readCartSummaryTotal(page: Page): Promise<number> {
  const total = page.getByTestId("cart-summary-total");
  await expect(total).toBeVisible({ timeout: 15_000 });
  const raw = await total.getAttribute("data-total");
  return Number(raw ?? "0");
}

/** Locate a visible cart row for a product by its title. */
export function cartItemByTitle(page: Page, title: string) {
  return page.locator('[data-testid="cart-item"]:visible').filter({ hasText: title }).first();
}

/** Read the guest cart that the storefront persists in localStorage. */
export function readGuestCart(page: Page) {
  return page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("cart") || "[]") as Array<{
        name?: string;
        quantity?: number;
      }>,
  );
}
