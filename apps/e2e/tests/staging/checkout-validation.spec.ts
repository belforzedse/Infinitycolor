import { expect, selectFixtureAddress, shopperApi, signIn, test, gotoStorefront } from "../../fixtures/staging";

test(
  "checkout without a delivery method is refused and places no order",
  { tag: "@regression" },
  async ({ page, shopper }) => {
    await signIn(page, shopper, "/");
    const api = await shopperApi(page);
    await api.post("/carts/add-item", { productVariationId: shopper.variations.inStock.id, count: 1 });
    const orderIds = async () =>
      (((await api.get("/orders/my-orders?page=1&pageSize=20")).data ?? []) as Array<{ id: number }>).map(
        (order) => order.id,
      );
    const before = await orderIds();

    await gotoStorefront(page, "/checkout");
    await selectFixtureAddress(page, shopper);
    await page.getByTestId("checkout-accept-terms").check();
    await page.getByTestId("checkout-submit").click();

    await expect(page.getByTestId("checkout-form-error")).toContainText("ارسال");
    await expect(page).toHaveURL(/\/checkout(?:[?#]|$)/);
    expect(await orderIds()).toEqual(before);
  },
);
