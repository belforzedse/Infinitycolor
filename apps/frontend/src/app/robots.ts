import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/config/site'

const BASE_URL = SITE_URL

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/admin',
          '/super-admin',
          '/account',
          '/api',
          '/_next',
          '/*.json$',
          '/cart',
          '/checkout',
          '/orders',
          '/payment',
          '/pdp/*?*',           // Disallow PDP with query params (e.g., /pdp/slug?variant=123)
          '/plp?*&*',           // Disallow PLP with multiple params (e.g., /plp?category=x&sort=y)
        ],
      },
      {
        userAgent: 'Googlebot',
        allow: '/',
        disallow: [
          '/admin',
          '/super-admin',
          '/account',
          '/api',
          '/_next',
          '/*.json$',
          '/cart',
          '/checkout',
          '/orders',
          '/payment',
          '/pdp/*?*',           // Disallow PDP with query params (e.g., /pdp/slug?variant=123)
          '/plp?*&*',           // Disallow PLP with multiple params (e.g., /plp?category=x&sort=y)
        ],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  }
}



