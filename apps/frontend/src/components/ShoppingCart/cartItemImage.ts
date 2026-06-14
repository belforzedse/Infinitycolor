import resolveAssetUrl from "@/utils/resolveAssetUrl";

const CART_ITEM_IMAGE_FALLBACK = "/images/cart/empty-cart.png";

export function resolveCartItemImage(image?: string | null): string {
  return resolveAssetUrl(image) || CART_ITEM_IMAGE_FALLBACK;
}
