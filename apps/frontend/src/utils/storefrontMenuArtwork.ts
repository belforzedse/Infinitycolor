export type StorefrontMenuArtwork = {
  src: string;
  alt: string;
};

const STOREFRONT_MENU_ARTWORK: Readonly<Record<string, StorefrontMenuArtwork>> = {
  "upper-body": {
    src: "/images/categories/megamenu/upper-body.webp",
    alt: "بالا تنه",
  },
  "lower-body": {
    src: "/images/categories/megamenu/lower-body.webp",
    alt: "پایین تنه",
  },
  sportswear: {
    src: "/images/categories/megamenu/sportswear.webp",
    alt: "لباس ورزشی",
  },
  underwear: {
    src: "/images/categories/megamenu/underwear.webp",
    alt: "لباس زیر",
  },
};

export function getStorefrontMenuArtwork(key: string): StorefrontMenuArtwork | null {
  return STOREFRONT_MENU_ARTWORK[key] ?? null;
}
