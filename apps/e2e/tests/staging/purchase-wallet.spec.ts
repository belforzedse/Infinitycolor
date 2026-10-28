import {
  addInStockVariationToCart,
  expect,
  selectFirstShipping,
  selectFixtureAddress,
  shopperApi,
  signIn,
  test,
  gotoStorefront,
} from "../../fixtures/staging";

// Enough credit for the product and any delivery fee.
test.use({ walletToman: 1_000_000 });

/**
 * A complete purchase paid from wallet credit: the only payment path that
 * settles entirely inside Infinity (no provider redirect). Non-blocking by
 * decision — see apps/e2e/README.md.
 */
test(
  "a shopper pays for an order with wallet credit and the store records it",
  { tag: "@purchase" },
  async ({ page, shopper, fixtureApi }) => {
    expect(
      shopper.checks.gateways,
      "staging has no active Wallet payment gateway; enable it in the admin payment gateways",
    ).toContain("wallet");
    const variation = shopper.variations.inStock;
    const stockBefore = (await fixtureApi.stock(shopper.slot))[variation.sku];

    await test.step("sign in, choose the variant and add it", async () => {
      await signIn(page, shopper, `/pdp/${shopper.product.slug}`);
      await addInStockVariationToCart(page, shopper);
    });

    let payable = 0;
    await test.step("check out paying entirely from the wallet", async () => {
      await gotoStorefront(page, "/checkout");
      await selectFixtureAddress(page, shopper);
      await selectFirstShipping(page);
      await page.getByTestId("wallet-contribution-toggle").check();
      await expect(page.getByTestId("payment-gateway-wallet-only")).toBeVisible();
      payable = Number(
        (await page.getByTestId("wallet-contribution-wallet-leg").innerText())
          .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
          .replace(/[^\d]/g, ""),
      );
      await page.getByTestId("checkout-accept-terms").check();
      await page.getByTestId("checkout-submit").click();
    });

    let orderId = 0;
    await test.step("the result page confirms the payment", async () => {
      await expect(page).toHaveURL(/\/payment\/result\?.*orderId=\d+/);
      orderId = Number(new URL(page.url()).searchParams.get("orderId"));
      await expect(page.getByTestId("payment-result")).toBeVisible();
      await expect(page.getByRole("heading", { name: "پرداخت با موفقیت ثبت شد" })).toBeVisible();
    });

    await test.step("the order, cart, stock and wallet agree with what was bought", async () => {
      const api = await shopperApi(page);
      const status = (await api.get(`/orders/${orderId}/payment-status`)).data;
      expect(status).toMatchObject({ isPaid: true, status: "Started", paymentGateway: "Wallet" });

      const order = (await api.get(`/orders/my-orders/${orderId}`)).data;
      expect(order.order_items.map((item: any) => [item.ProductSKU, item.Count, Number(item.PerAmount)])).toEqual([
        [variation.sku, 1, variation.priceToman],
      ]);

      await expect.poll(async () => (await api.get("/carts/me")).data?.cart_items ?? []).toEqual([]);

      expect((await fixtureApi.stock(shopper.slot))[variation.sku]).toEqual({
        count: stockBefore.count - 1,
        reserved: stockBefore.reserved,
      });

      const wallet = (await api.get("/local-user-wallet/me")).data;
      expect(Number(wallet.balance)).toBe((shopper.walletToman - payable) * 10);
    });
  },
);
