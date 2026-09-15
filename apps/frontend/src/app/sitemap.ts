import type { MetadataRoute } from "next";
import { SITE_URL } from "@/config/site";
import { ENDPOINTS, getStrapiServerUrl } from "@/constants/api";
import { SITEMAP_TAG } from "@/constants/cacheTags";
import logger from "@/utils/logger";
import { getCategoryPlpHref } from "@/utils/plpRoutes";
import {
  fetchAllPdpEligibleProducts,
  getSitemapEligibleProducts,
  type PdpEligibleProduct,
} from "@/services/product/catalog";

const BASE_URL = SITE_URL;

interface BlogPost {
  id: number;
  Slug: string;
  PublishedAt?: string;
  updatedAt: string;
}

interface BlogCategory {
  id: number;
  Slug: string;
  updatedAt: string;
}

interface ProductCategory {
  id: number;
  Slug: string;
  updatedAt: string;
}

/**
 * Fetch every canonical, published, indexable product for the sitemap.
 * Shares the same complete-pagination enumerator as generateStaticParams
 * (apps/frontend/src/services/product/catalog.ts) so the two can't silently
 * drift — one paginating correctly while the other truncates. Unlike the
 * build-time caller, a Strapi failure here degrades to an empty product list
 * (this route regenerates hourly and on-demand, so a temporarily incomplete
 * sitemap is preferable to a broken sitemap route) rather than failing loud.
 */
async function getAllProducts(): Promise<PdpEligibleProduct[]> {
  try {
    const products = getSitemapEligibleProducts(
      await fetchAllPdpEligibleProducts({ tags: [SITEMAP_TAG] }),
    );
    logger.info(`[Sitemap] Fetched ${products.length} active products for sitemap`);
    return products;
  } catch (error: string | Error | any) {
    logger.error("[Sitemap] Error fetching products:", error);
    return [];
  }
}

/**
 * Fetch all published blog posts from the backend API
 */
async function getAllBlogPosts(): Promise<BlogPost[]> {
  const allPosts: BlogPost[] = [];
  let currentPage = 1;
  const pageSize = 100;
  const strapiBaseUrl = getStrapiServerUrl();

  try {
    while (true) {
      const endpoint =
        `${strapiBaseUrl}/blog-posts?` +
        `filters[Status][$eq]=Published&` +
        `pagination[page]=${currentPage}&` +
        `pagination[pageSize]=${pageSize}&` +
        `fields[0]=Slug&` +
        `fields[1]=PublishedAt&` +
        `fields[2]=updatedAt`;

      const response = await fetch(endpoint, {
        next: { revalidate: 3600, tags: [SITEMAP_TAG] },
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }).then((res) => res.json());

      const posts = response?.data || [];
      if (posts.length === 0) break;

      allPosts.push(
        ...posts.map((post: any) => ({
          id: post.id,
          Slug: post.attributes?.Slug || post.attributes?.slug || post.Slug || post.slug,
          PublishedAt:
            post.attributes?.PublishedAt || post.attributes?.publishedAt || post.PublishedAt,
          updatedAt: post.attributes?.updatedAt || post.updatedAt,
        })),
      );

      const pageCount = response?.meta?.pagination?.pageCount || 1;
      if (currentPage >= pageCount) break;

      currentPage++;
    }

    logger.info(`[Sitemap] Fetched ${allPosts.length} blog posts for sitemap`);
    return allPosts;
  } catch (error: string | Error | any) {
    logger.error("[Sitemap] Error fetching blog posts:", error);
    return [];
  }
}

/**
 * Fetch all blog categories from the backend API
 */
async function getAllBlogCategories(): Promise<BlogCategory[]> {
  try {
    const endpoint =
      `${getStrapiServerUrl()}/blog-categories?` +
      `pagination[pageSize]=100&` +
      `fields[0]=Slug&` +
      `fields[1]=updatedAt`;

    const response = await fetch(endpoint, {
      next: { revalidate: 3600, tags: [SITEMAP_TAG] },
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }).then((res) => res.json());

    const categories = (response?.data || []).map((cat: any) => ({
      id: cat.id,
      Slug: cat.attributes?.Slug || cat.Slug,
      updatedAt: cat.attributes?.updatedAt || cat.updatedAt,
    }));

    logger.info(`[Sitemap] Fetched ${categories.length} blog categories for sitemap`);
    return categories;
  } catch (error: string | Error | any) {
    logger.error("[Sitemap] Error fetching blog categories:", error);
    return [];
  }
}

async function getAllProductCategories(): Promise<ProductCategory[]> {
  try {
    const endpoint =
      `${getStrapiServerUrl()}${ENDPOINTS.PRODUCT.CATEGORY}?` +
      `pagination[pageSize]=100&` +
      `fields[0]=Slug&` +
      `fields[1]=updatedAt`;

    const response = await fetch(endpoint, {
      next: { revalidate: 3600, tags: [SITEMAP_TAG] },
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }).then((res) => res.json());

    const categories = (response?.data || [])
      .map((cat: any) => ({
        id: cat.id,
        Slug: cat.attributes?.Slug || cat.Slug,
        updatedAt: cat.attributes?.updatedAt || cat.updatedAt,
      }))
      .filter((cat: ProductCategory) => Boolean(cat.Slug));

    logger.info(`[Sitemap] Fetched ${categories.length} product categories for sitemap`);
    return categories;
  } catch (error: string | Error | any) {
    logger.error("[Sitemap] Error fetching product categories:", error);
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Fetch all data in parallel
  const [products, blogPosts, blogCategories, productCategories] = await Promise.all([
    getAllProducts(),
    getAllBlogPosts(),
    getAllBlogCategories(),
    getAllProductCategories(),
  ]);

  // Disallow-list for sitemap (must stay aligned with robots.txt)
  const disallowedPaths = new Set([
    "/cart",
    "/checkout",
    "/orders",
    "/payment",
    "/account",
    "/admin",
    "/super-admin",
    "/_next",
    "/api",
  ]);

  // Calculate total URL count
  const totalUrls =
    1 + // Homepage
    1 + // PLP
    1 + // Categories
    1 + // Blog listing
    1 + // Returns
    productCategories.length +
    products.length +
    blogPosts.length +
    blogCategories.length;

  // Note: If totalUrls exceeds 50,000, consider implementing sitemap index
  // Next.js 16 supports sitemap index by returning an array of sitemap objects
  // For now, we return a single sitemap (Next.js handles up to 50,000 URLs efficiently)
  if (totalUrls > 50000) {
    logger.warn(
      `[Sitemap] Total URLs (${totalUrls}) exceeds 50,000. Consider implementing sitemap index.`,
    );
  }

  // Build sitemap entries
  const sitemap: MetadataRoute.Sitemap = [
    // Homepage
    {
      url: BASE_URL,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1.0,
    },

    // PLP (Product List Page)
    {
      url: `${BASE_URL}/plp`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.9,
    },

    // Categories page
    {
      url: `${BASE_URL}/categories`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.9,
    },

    // Product category PLPs
    ...productCategories.map((category) => ({
      url: `${BASE_URL}${getCategoryPlpHref(category.Slug)}`,
      lastModified: new Date(category.updatedAt),
      changeFrequency: "daily" as const,
      priority: 0.85,
    })),

    // Blog listing page
    {
      url: `${BASE_URL}/blog`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 0.8,
    },

    {
      url: `${BASE_URL}/returns`,
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.4,
    },

    // Product Detail Pages (PDPs). fetchAllPdpEligibleProducts already excludes
    // unroutable/empty slugs and deduplicates by canonical slug, so every entry
    // here is guaranteed valid and appears exactly once.
    ...products.map((product) => ({
      url: `${BASE_URL}/pdp/${product.slug}`,
      lastModified: new Date(product.updatedAt),
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),

    // Blog post pages
    ...blogPosts.map((post) => ({
      url: `${BASE_URL}/${post.Slug}`,
      lastModified: post.PublishedAt ? new Date(post.PublishedAt) : new Date(post.updatedAt),
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),

    // Blog category pages
    ...blogCategories.map((category) => ({
      url: `${BASE_URL}/blog?category=${category.Slug}`,
      lastModified: new Date(category.updatedAt),
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
  ];

  // Final defensive filter to drop disallowed paths (e.g., cart/checkout/account)
  const filtered = sitemap.filter((entry) => {
    try {
      const urlObj = new URL(entry.url);
      return !disallowedPaths.has(urlObj.pathname);
    } catch {
      // Drop malformed entries to avoid invalid sitemap rows
      return false;
    }
  });

  return filtered;
}
