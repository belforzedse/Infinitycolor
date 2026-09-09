/**
 * Category name substrings used as fallback filter when "Featured" is not used.
 * Includes مانتو and پلیور so they match Strapi category names; used for
 * homepage carousel and bottom nav sheet when featuredOnly is false.
 */
export const ALLOWED_HOME_NAV_CATEGORY_NAME_SUBSTRINGS: readonly string[] = [
  "کیف",
  "دامن",
  "کت",
  "لباس زیر",
  "شال و روسری",
  "پیراهن",
  "شلوار",
  "مانتو",
  "پلیور",
];

/**
 * Featured main categories for the homepage carousel, bottom-nav sheet,
 * and about-page category rail. If none are marked featured, the service
 * falls back to `allowedNameSubstrings`.
 */
export const STOREFRONT_MAIN_CATEGORY_OPTIONS = {
  mainOnly: true,
  sort: "Title:asc",
  featuredOnly: true,
  allowedNameSubstrings: ALLOWED_HOME_NAV_CATEGORY_NAME_SUBSTRINGS,
} as const;

/**
 * Hardcoded storefront header item. PLP `search` matches Oppsi titles the same
 * way `/offer/oppsi` already redirects.
 */
export const OPPSI_HEADER_ITEM = {
  key: "oppsi",
  label: "Oppsi",
  href: "/plp?search=Oppsi",
} as const;

/**
 * Hardcoded top-level header categories that are not assigned on the Navigation
 * single type. Rendered like other navbar categories (پیراهن, شال, …).
 */
export const HEADER_EXTRA_CATEGORIES = [
  {
    id: -10001,
    name: "کمربند",
    slug: "womens-belt",
    megaMenuImageUrl: "/images/categories/womens-belt.jpg",
    megaMenuImageAlt: "کمربند",
    megaMenuImageWidth: 682,
    megaMenuImageHeight: 1024,
  },
] as const;
