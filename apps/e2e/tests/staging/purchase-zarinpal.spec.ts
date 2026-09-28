import {
  addInStockVariationToCart,
  expect,
  selectFirstShipping,
  selectFixtureAddress,
  shopperApi,
  signIn,
  test,
  type Shopper,
  gotoStorefront,
} from "../../fixtures/staging";
import type { Page } from "@playwright/test";

/**
 * The bank-gateway round trip through ZarinPal's official sandbox: our
 * finalize, the redirect out, the provider's return to our callback, the
 * server-side verification and settlement, and the result page. Non-blocking
 * by decision (a sandbox outage must not stop a release); the live-gateway
 * tripwire in fixtures/staging.ts fails the test if the redirect ever points at
 * ZarinPal's real payment host.
 */

async function checkoutToZarinpal(page: Page, shopper: Shopper) {
  expect(
    shopper.checks.gateways,
    "staging does not offer ZarinPal; configure the sandbox merchant (ZARINPAL_MERCHANT_ID, ZARINPAL_SANDBOX=true)",
  ).toContain("zarinpal");
  await signIn(page, shopper, `/pdp/${shopper.product.slug}`);
  await addInStockVariationToCart(page, shopper);
  await gotoStorefront(page, "/checkout");
  await selectFixtureAddress(page, shopper);
  await selectFirstShipping(page);
  const zarinpal = page.getByTestId("payment-gateway-zarinpal");
  await zarinpal.click();
  await expect(zarinpal).toHaveAttribute("data-selected", "true");
  await page.getByTestId("checkout-accept-terms").check();

  const finalized = page.waitForResponse(
    (response) => /\/api\/carts\/finalize(?:\?|$)/.test(response.url()) && response.request().method() === "POST",
  );
  await page.getByTestId("checkout-submit").click();
  const response = await finalized;
  expect(response.ok(), `finalize failed (${response.status()})`).toBe(true);
  const body = await response.json();
  const orderId = Number((body.data ?? body).orderId);
  expect(orderId).toBeGreaterThan(0);

  await expect(page, "the redirect must go to the sandbox, never the live gateway").toHaveURL(
    /^https:\/\/sandbox\.zarinpal\.com\//,
  );
  return orderId;
}

/** The sandbox page offers one link per outcome; each carries its status back. */
async function answerOnSandbox(page: Page, outcome: "OK" | "NOK") {
  await page.locator(`a[href*="status=${outcome}"]`).first().click();
  await expect(page).toHaveURL(/\/payment\/result\?/);
}

test(
  "a shopper pays through the ZarinPal sandbox and the store settles the order",
  { tag: "@purchase" },
  async ({ page, shopper, fixtureApi }) => {
    const variation = shopper.variations.inStock;
    const stockBefore = (await fixtureApi.stock(shopper.slot))[variation.sku];
    const orderId = await checkoutToZarinpal(page, shopper);

    await answerOnSandbox(page, "OK");
    await expect(page.getByRole("heading", { name: "پرداخت با موفقیت ثبت شد" })).toBeVisible();

    const api = await shopperApi(page);
    expect((await api.get(`/orders/${orderId}/payment-status`)).data).toMatchObject({
      isPaid: true,
      status: "Started",
      paymentGateway: "ZarinPal",
    });
    await expect.poll(async () => (await api.get("/carts/me")).data?.cart_items ?? []).toEqual([]);
    expect((await fixtureApi.stock(shopper.slot))[variation.sku]).toEqual({
      count: stockBefore.count - 1,
      reserved: stockBefore.reserved,
    });
  },
);

test(
  "a shopper who cancels on the ZarinPal sandbox is not charged and the stock comes back",
  { tag: "@purchase" },
  async ({ page, shopper, fixtureApi }) => {
    const variation = shopper.variations.inStock;
    const stockBefore = (await fixtureApi.stock(shopper.slot))[variation.sku];
    const orderId = await checkoutToZarinpal(page, shopper);

    await answerOnSandbox(page, "NOK");
    await expect(page.getByTestId("payment-result")).toBeVisible();
    await expect(page.getByRole("heading", { name: "پرداخت با موفقیت ثبت شد" })).toHaveCount(0);

    const api = await shopperApi(page);
    expect((await api.get(`/orders/${orderId}/payment-status`)).data).toMatchObject({
      isPaid: false,
      status: "Cancelled",
    });
    expect((await fixtureApi.stock(shopper.slot))[variation.sku]).toEqual(stockBefore);
  },
);
