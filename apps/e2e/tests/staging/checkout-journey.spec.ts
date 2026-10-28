import {
  addInStockVariationToCart,
  cartRows,
  checkoutQuote,
  expect,
  localPhone,
  offeredGateways,
  openFixtureCategory,
  productCardLink,
  readToman,
  selectFirstShipping,
  selectFixtureAddress,
  shopperApi,
  signInFromAuthPage,
  stagingTargets,
  test,
  gotoStorefront,
  waitForAppReady,
} from "../../fixtures/staging";

// Codes the quote may be asked about. SnappPay is last: its quote makes a
// synchronous eligibility call to SnappPay, a third party.
const QUOTE_GATEWAY_PREFERENCE = ["zarinpal", "mellat", "samankish", "snappay"];

/**
 * The deployment gate. A guest discovers a product, puts the right variant in
 * the cart, is sent to sign in at checkout, comes back with the cart intact,
 * chooses where and how to receive it, and is offered payment at the price the
 * server will charge. It stops before payment: no order is placed, so a
 * third-party payment outage can never block a release.
 */
test(
  "a guest finds a product, signs in at checkout and reaches payment at the server's price",
  { tag: "@critical" },
  async ({ page, shopper, pageErrors }) => {
    const { storefront } = stagingTargets();
    const variation = shopper.variations.inStock;

    await test.step("find the product on its listing and open it", async () => {
      await openFixtureCategory(page, shopper);
      await productCardLink(page, shopper).click();
      await expect(page).toHaveURL(new RegExp(`/pdp/${shopper.product.slug}(?:[?#]|$)`));
      await expect(page.getByTestId("pdp-product-title").filter({ visible: true })).toHaveText(shopper.product.title);
    });

    await test.step("choose colour and size and add it to the cart", async () => {
      await addInStockVariationToCart(page, shopper);
    });

    await test.step("the cart holds exactly that variant, once, at its price", async () => {
      await gotoStorefront(page, "/cart");
      const row = cartRows(page);
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute("data-cart-variation-id", String(variation.id));
      await expect(row.getByTestId("cart-quantity-control")).toContainText("۱");
      await expect(page.getByTestId("cart-summary-total")).toHaveAttribute(
        "data-total",
        String(variation.priceToman),
      );
    });

    await test.step("checkout sends the guest to sign in and brings them back", async () => {
      await page.getByRole("link", { name: "ادامه فرآیند خرید و تسویه حساب" }).click();
      await expect(page).toHaveURL(/\/auth\?/);
      expect(new URL(page.url()).searchParams.get("returnTo")).toBe(`${storefront}/checkout`);
      await signInFromAuthPage(page, shopper);
      await expect(page).toHaveURL(`${storefront}/checkout`);
      await waitForAppReady(page);
      await expect(page.getByTestId("checkout-auth-gate")).toHaveCount(0);
    });

    const orderIds = async () => {
      const orders = await (await shopperApi(page)).get("/orders/my-orders?page=1&pageSize=20");
      return ((orders.data ?? []) as Array<{ id: number }>).map((order) => order.id);
    };
    let ordersBefore: number[] = [];

    await test.step("the guest's line moved into the shopper's own cart", async () => {
      ordersBefore = await orderIds();
      const api = await shopperApi(page);
      await expect
        .poll(async () => {
          const cart = await api.get("/carts/me");
          return (cart.data?.cart_items ?? []).map((item: any) => ({
            variation: item.product_variation?.id,
            count: item.Count,
          }));
        })
        .toEqual([{ variation: variation.id, count: 1 }]);
    });

    let shippingId = 0;
    await test.step("choose the delivery address and a delivery method", async () => {
      await selectFixtureAddress(page, shopper);
      shippingId = await selectFirstShipping(page);
      expect(shippingId).toBeGreaterThan(0);
    });

    await test.step("payment is offered, at the total the server quotes", async () => {
      const gateways = await offeredGateways(page);
      const gateway = QUOTE_GATEWAY_PREFERENCE.find((code) => gateways.includes(code));
      expect(gateway, `no bank gateway is offered (saw: ${gateways.join(", ")})`).toBeTruthy();
      const payable = await readToman(page.getByTestId("checkout-payable-total"));

      const quote = await checkoutQuote(await shopperApi(page), {
        shipping: shippingId,
        addressId: shopper.address.id,
        gateway: gateway!,
        mobile: localPhone(shopper),
      });
      expect(quote.financialSummary.subtotal).toBe(variation.priceToman);
      expect(quote.financialSummary.total, "the checkout shows a different total than the server charges").toBe(
        payable,
      );
    });

    await test.step("no order was placed", async () => {
      expect(await orderIds()).toEqual(ordersBefore);
    });

    expect(pageErrors, "uncaught errors on the storefront or auth pages").toEqual([]);
  },
);
