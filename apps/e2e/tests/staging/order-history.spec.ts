import {
  expect,
  localPhone,
  placeOrderThroughApi,
  shippingOptions,
  shopperApi,
  signIn,
  test,
  gotoStorefront,
} from "../../fixtures/staging";

test.use({ walletToman: 1_000_000 });

test(
  "an order the shopper placed appears in their order history",
  { tag: "@regression" },
  async ({ page, shopper }) => {
    expect(shopper.checks.gateways, "staging has no active Wallet payment gateway").toContain("wallet");
    await signIn(page, shopper, "/");
    const api = await shopperApi(page);
    await api.post("/carts/add-item", { productVariationId: shopper.variations.inStock.id, count: 1 });
    const [shipping] = await shippingOptions(api, shopper.address.id);

    const { finalize } = await placeOrderThroughApi(api, {
      shipping: shipping.id,
      addressId: shopper.address.id,
      gateway: "wallet",
      mobile: localPhone(shopper),
    });
    expect(finalize.paymentStatus).toBe("Succeeded");

    await gotoStorefront(page, "/orders");
    await expect(page.getByText(shopper.product.title).filter({ visible: true }).first()).toBeVisible();
  },
);
