import { translateErrorMessage } from "../errorTranslations";

describe("translateErrorMessage — products that left the store", () => {
  it.each([
    [
      'PRODUCT_DELETED: Product "Blue shirt" has been removed',
      "این محصول دیگر در فروشگاه موجود نیست. لطفاً آن را از سبد خرید حذف کنید.",
    ],
    [
      'PRODUCT_INACTIVE: Product "Blue shirt" is currently unavailable',
      "این محصول در حال حاضر قابل خرید نیست. لطفاً آن را از سبد خرید حذف کنید.",
    ],
    [
      "VARIATION_UNPUBLISHED: Product variation 42 is not available for purchase",
      "این مدل از محصول در حال حاضر قابل خرید نیست.",
    ],
    ["Product is no longer available", "این محصول دیگر در فروشگاه موجود نیست."],
    ["Product is currently unavailable", "این محصول در حال حاضر قابل خرید نیست."],
    ["Product is not available", "این محصول در حال حاضر قابل خرید نیست."],
    ["Product variation is not available", "این مدل از محصول در حال حاضر قابل خرید نیست."],
    ["Product not found", "این محصول یافت نشد یا دیگر در فروشگاه موجود نیست."],
  ])("explains %j in Persian instead of the generic fallback", (message, expected) => {
    expect(translateErrorMessage(message, "fallback")).toBe(expected);
  });

  it("still answers unrelated not-found errors with the generic text", () => {
    expect(translateErrorMessage("Resource not found", "fallback")).toBe("موردی یافت نشد.");
  });
});
