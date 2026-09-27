import { addInStockVariationToCart, cartRows, expect, shopperApi, signIn, test, gotoStorefront } from "../../fixtures/staging";

test(
  "quantity changes and removal in the cart are saved to the shopper's cart",
  { tag: "@regression" },
  async ({ page, shopper }) => {
    const variation = shopper.variations.inStock;
    await signIn(page, shopper, `/pdp/${shopper.product.slug}`);
    await addInStockVariationToCart(page, shopper);
    const api = await shopperApi(page);
    const serverLines = async () =>
      ((await api.get("/carts/me")).data?.cart_items ?? []).map((item: any) => item.Count);

    await gotoStorefront(page, "/cart");
    const row = cartRows(page);
    await row.getByRole("button", { name: "افزایش تعداد کالا" }).click();
    await expect(page.getByTestId("cart-summary-total")).toHaveAttribute(
      "data-total",
      String(variation.priceToman * 2),
    );
    await expect.poll(serverLines).toEqual([2]);

    await row.getByRole("button", { name: "حذف کالا از سبد خرید" }).click();
    await expect(cartRows(page)).toHaveCount(0);
    await expect.poll(serverLines).toEqual([]);
  },
);

test(
  "a variant with no stock is shown as unavailable and cannot be chosen",
  { tag: "@regression" },
  async ({ page, shopper }) => {
    await gotoStorefront(page, `/pdp/${shopper.product.slug}`);
    const { color } = shopper.variations.outOfStock;
    await expect(page.getByRole("button", { name: `رنگ ${color} ناموجود` })).toBeDisabled();
    await expect(page.getByRole("button", { name: `انتخاب رنگ ${shopper.variations.inStock.color}` })).toBeEnabled();
  },
);
