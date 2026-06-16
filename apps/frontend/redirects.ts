import type { Redirect } from "next/dist/lib/load-custom-routes";

const PERMANENT_LEGACY_REDIRECT = { statusCode: 301 } as const;

/**
 * Permanent redirects from legacy WordPress / old storefront URLs.
 *
 * These must be wired through next.config `redirects()` so they are present in
 * Next's generated routes manifest before pages are matched.
 */
export const legacyRedirects: Redirect[] = [
  {
    source: "/shop/page/:page(\\d+)",
    destination: "/plp?page=:page",
    ...PERMANENT_LEGACY_REDIRECT,
  },
  {
    source: "/shop/:slug/page/:page(\\d+)",
    destination: "/plp/category/:slug?page=:page",
    ...PERMANENT_LEGACY_REDIRECT,
  },
  {
    source: "/shop/:parent/:slug/page/:page(\\d+)",
    destination: "/plp/category/:slug?page=:page",
    ...PERMANENT_LEGACY_REDIRECT,
  },
  {
    source: "/shop",
    destination: "/plp",
    ...PERMANENT_LEGACY_REDIRECT,
  },
  {
    source: "/shop/:slug",
    destination: "/plp/category/:slug",
    ...PERMANENT_LEGACY_REDIRECT,
  },
  {
    source: "/shop/:parent/:slug",
    destination: "/plp/category/:slug",
    ...PERMANENT_LEGACY_REDIRECT,
  },
  {
    source: "/product/:slug",
    destination: "/pdp/:slug",
    ...PERMANENT_LEGACY_REDIRECT,
  },
  {
    source: "/my-account/orders",
    destination: "/orders",
    ...PERMANENT_LEGACY_REDIRECT,
  },
  {
    source: "/my-account",
    destination: "/account",
    ...PERMANENT_LEGACY_REDIRECT,
  },
  {
    source: "/user-login",
    destination: "/auth",
    ...PERMANENT_LEGACY_REDIRECT,
  },
  {
    source: "/payment",
    destination: "/checkout",
    ...PERMANENT_LEGACY_REDIRECT,
  },
  {
    source: "/sitemap_index.xml",
    destination: "/sitemap.xml",
    ...PERMANENT_LEGACY_REDIRECT,
  },
  {
    source: "/Ø³ÙˆØ§Ù„Ø§Øª-Ù…ØªØ¯Ø§ÙˆÙ„",
    destination: "/faq",
    ...PERMANENT_LEGACY_REDIRECT,
  },
];
