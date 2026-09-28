import { cartRows, expect, gotoStorefront, shopperApi, signIn, test } from "../../fixtures/staging";

/**
 * A product can leave the store (back to draft, scheduled, or Trash) while a
 * shopper has it open or in the cart. It must never be sold after that, and the
 * shopper should be told why in Persian. The fixture's cleanup republishes the
 * product whatever happens here.
 */
test(
  "adding a product that left the store while its page was open is refused, and the shopper is told",
  { tag: "@regression" },
  async ({ page, shopper, fixtureApi }) => {
    const { color, size } = shopper.variations.inStock;
    await signIn(page, shopper, `/pdp/${shopper.product.slug}`);
    await page.getByRole("button", { name: `انتخاب رنگ ${color}` }).click();
    await page.getByRole("button", { name: `انتخاب سایز ${size}` }).click();
    await expect(page.getByTestId("pdp-cart-action")).toHaveAttribute("data-cart-ready", "true");

    expect((await fixtureApi.setProductPublished(shopper.slot, false)).published).toBe(false);

    await page.getByRole("button", { name: "افزودن به سبد خرید" }).click();
    await expect(page.getByText("این محصول در حال حاضر قابل خرید نیست.").first()).toBeVisible();
    const api = await shopperApi(page);
    expect((await api.get("/carts/me")).data?.cart_items ?? []).toEqual([]);
  },
);

test(
  "a cart line whose product left the store is removed, and the shopper is told which one",
  { tag: "@regression" },
  async ({ page, shopper, fixtureApi }) => {
    await signIn(page, shopper, "/");
    const api = await shopperApi(page);
    await api.post("/carts/add-item", { productVariationId: shopper.variations.inStock.id, count: 1 });

    expect((await fixtureApi.setProductPublished(shopper.slot, false)).published).toBe(false);

    await gotoStorefront(page, "/cart");
    await expect(cartRows(page)).toHaveCount(0);
    // The stock check removes the line and names it; before 09-28 the line was
    // hidden from it too, so the cart just emptied without a word.
    await expect(page.getByTestId("cart-stock-notice").first()).toContainText(shopper.product.title);
    expect((await api.get("/carts/me")).data?.cart_items ?? []).toEqual([]);
  },
);
