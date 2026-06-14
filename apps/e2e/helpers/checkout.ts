import { expect, type Page } from "@playwright/test";
import { E2E_ADDRESS_FULL } from "../fixtures/storefront";

/**
 * Open the address Headless-UI listbox and pick the deterministic seeded address.
 * Selecting it auto-hydrates province/city/postal/full-address, which in turn
 * enables the shipping options.
 */
export async function selectSeededAddress(page: Page) {
  const wrapper = page.getByTestId("checkout-address-select");
  await expect(wrapper).toBeVisible({ timeout: 30_000 });
  await wrapper.getByRole("button").first().click();
  const option = page.getByRole("option", { name: new RegExp(E2E_ADDRESS_FULL) }).first();
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();
}

/** Pick the first available (enabled) shipping method radio. */
export async function selectFirstShipping(page: Page) {
  const stableLocalOption = page
    .locator(
      '[data-testid="checkout-shipping-option"][data-shipping-id="1"], [data-testid="checkout-shipping-option"][data-shipping-id="2"], [data-testid="checkout-shipping-option"][data-shipping-id="3"]',
    )
    .first();
  const option = (await stableLocalOption.count())
    ? stableLocalOption
    : page.locator('[data-testid="checkout-shipping-option"]').first();
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();
}

/** Select the Zarinpal payment gateway and confirm it became the active choice. */
export async function selectZarinpalGateway(page: Page) {
  const zarinpal = page.getByTestId("payment-gateway-zarinpal");
  await expect(zarinpal).toBeVisible({ timeout: 15_000 });
  await zarinpal.click();
  await expect(zarinpal).toHaveAttribute("data-selected", "true");
}

/**
 * Fill the authenticated checkout form to a payable state (address + shipping +
 * Zarinpal) without submitting. Name/phone are pre-filled from the seeded user.
 */
export async function fillCheckoutWithZarinpal(page: Page) {
  await expect(page.getByTestId("checkout-auth-gate")).toHaveCount(0);
  await expect(page.getByTestId("checkout-submit")).toBeVisible({ timeout: 30_000 });
  await selectSeededAddress(page);
  await selectFirstShipping(page);
  await selectZarinpalGateway(page);
}
