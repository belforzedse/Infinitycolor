// @ts-nocheck
/**
 * product controller
 */

import { factories } from "@strapi/strapi";
import { roleIsAllowed, MANAGEMENT_ROLES } from "../../../utils/roles";
import {
  buildCacheKey,
  getCacheTtlFromEnv,
  isCacheDebugHeaderEnabled,
  shouldBypassEndpointCache,
  withCache,
  type CacheStatus,
} from "../../../utils/responseCache";
import {
  SEARCHWISE_PRODUCT_FILTERS,
  SEARCHWISE_PRODUCT_POPULATE,
  buildSearchwiseFeedPayload,
  isSearchwiseAuthorized,
  parseSearchwisePage,
  parseSearchwiseSize,
} from "../services/searchwise-feed";
import { generateVariationCombinations } from "../services/variation-combinations";

/**
 * Check if the user is an admin (superadmin, store manager, or editor)
 * Supports both plugin::users-permissions.user roles and local-user roles
 * @param user - The user object from ctx.state.user
 * @returns true if user is an admin, false otherwise
 */
function isAdminUser(user: any): boolean {
  if (!user) return false;

  // Check explicit isAdmin flag (set by auth/self endpoint)
  if (user?.isAdmin === true) {
    return true;
  }

  // Check local-user role (role ID 2 is admin)
  const userRoleId = user?.user_role?.id;
  if (userRoleId === 2) {
    return true;
  }

  // Check plugin::users-permissions role using existing utilities
  const roleName = user?.role?.name;
  if (roleName) {
    // Use existing role matching utility with MANAGEMENT_ROLES
    if (roleIsAllowed(roleName, MANAGEMENT_ROLES)) {
      return true;
    }
  }

  return false;
}

function readProductStatus(product: any): string | undefined {
  return product?.attributes?.Status || product?.Status;
}

function readProductRemovedAt(product: any): string | null | undefined {
  return product?.attributes?.removedAt || product?.removedAt;
}

function setCacheHeaderIfEnabled(ctx: any, status: CacheStatus) {
  if (!isCacheDebugHeaderEnabled()) return;
  ctx.set("X-Backend-Cache", status);
}

const SEARCHWISE_FULL_FEED_BATCH_SIZE = 500;

const searchwiseCacheTtl = () => getCacheTtlFromEnv("CACHE_TTL_SEARCHWISE_FEED_SEC", 3600);

const readSearchwiseHeaders = (ctx: any): Record<string, unknown> =>
  (ctx.request?.headers || {}) as Record<string, unknown>;

async function findSearchwiseProductsPage(strapi: any, page: number, size: number) {
  const start = (page - 1) * size;
  const [products, total] = await Promise.all([
    strapi.entityService.findMany("api::product.product", {
      filters: SEARCHWISE_PRODUCT_FILTERS,
      populate: SEARCHWISE_PRODUCT_POPULATE,
      sort: { updatedAt: "desc" },
      start,
      limit: size,
    }),
    strapi.db.query("api::product.product").count({
      where: SEARCHWISE_PRODUCT_FILTERS,
    }),
  ]);

  return {
    products,
    pagination: {
      page,
      size,
      pageCount: Math.ceil(total / size),
      total,
    },
  };
}

async function findAllSearchwiseProducts(strapi: any) {
  const allProducts: any[] = [];
  let page = 1;

  while (true) {
    const { products, pagination } = await findSearchwiseProductsPage(
      strapi,
      page,
      SEARCHWISE_FULL_FEED_BATCH_SIZE,
    );
    allProducts.push(...products);

    if (page >= pagination.pageCount || products.length === 0) break;
    page += 1;
  }

  return allProducts;
}

const PRODUCT_POPULATE = {
  CoverImage: true,
  Media: true,
  Files: true,
  product_main_category: true,
  product_other_categories: true,
  product_tags: true,
  product_reviews: {
    populate: {
      user: {
        fields: ["id", "username", "phone", "email"],
        populate: {
          user_info: {
            fields: ["FirstName", "LastName"],
          },
        },
      },
    },
  },
  product_variations: {
    populate: {
      product_variation_color: true,
      product_variation_size: true,
      product_variation_model: true,
      selected_attribute_terms: {
        populate: {
          product_attribute: true,
        },
      },
      product_stock: true,
    },
  },
  product_attribute_assignments: {
    populate: {
      product_attribute: true,
      terms: {
        populate: {
          product_attribute: true,
        },
      },
    },
  },
  product_faqs: true,
  product_size_helper: {
    populate: {
      Image: true,
    },
  },
} as const;

const PRODUCT_SHELL_POPULATE = {
  CoverImage: true,
  Media: true,
  Files: true,
  product_main_category: true,
  product_other_categories: true,
  product_tags: true,
  product_variations: {
    populate: {
      product_variation_color: true,
      product_variation_size: true,
      product_variation_model: true,
      selected_attribute_terms: {
        populate: {
          product_attribute: true,
        },
      },
      product_stock: true,
    },
  },
  product_attribute_assignments: {
    populate: {
      product_attribute: true,
      terms: {
        populate: {
          product_attribute: true,
        },
      },
    },
  },
  product_faqs: true,
  product_size_helper: {
    populate: {
      Image: true,
    },
  },
} as const;

function getProductPopulateForView(view: unknown) {
  return String(view || "").trim().toLowerCase() === "shell"
    ? PRODUCT_SHELL_POPULATE
    : PRODUCT_POPULATE;
}

async function findProductBySlugInternal(
  strapi: any,
  decodedSlug: string,
  isAdmin: boolean,
  populate: typeof PRODUCT_POPULATE | typeof PRODUCT_SHELL_POPULATE = PRODUCT_POPULATE,
): Promise<any | null> {
  const filters: any = {
    Slug: decodedSlug,
    removedAt: { $null: true },
  };

  if (!isAdmin) {
    filters.Status = "Active";
  }

  let products = await strapi.entityService.findMany("api::product.product", {
    filters,
    populate,
    pagination: { limit: 1 },
  });

  let product = (products as unknown[])[0] || null;

  if (!product) {
    strapi.log.info(
      `[Product.findBySlug] No exact match for slug: "${decodedSlug}", trying raw SQL query...`,
    );
    try {
      const knex = strapi.db.connection;
      let rawQuery = knex("products").where("slug", decodedSlug).whereNull("removed_at");

      if (!isAdmin) {
        rawQuery = rawQuery.where("status", "Active");
      }

      const rawProducts = await rawQuery.limit(1);
      if (rawProducts.length > 0) {
        const productId = rawProducts[0].id;
        const foundFilters: any = { id: productId };

        if (!isAdmin) {
          foundFilters.Status = "Active";
        }

        const foundProducts = await strapi.entityService.findMany("api::product.product", {
          filters: foundFilters,
          populate,
          pagination: { limit: 1 },
        });
        product = (foundProducts as unknown[])[0] || null;
        if (product) {
          strapi.log.info(`[Product.findBySlug] Found product via raw SQL query: ${productId}`);
        }
      }
    } catch (sqlError) {
      strapi.log.warn("[Product.findBySlug] Raw SQL query failed:", sqlError);
    }
  }

  if (!product) {
    strapi.log.info(
      `[Product.findBySlug] No product found with slug: "${decodedSlug}", trying ID fallback...`,
    );

    const idMatch = decodedSlug.match(/^\d+$/);
    if (idMatch) {
      const productId = parseInt(decodedSlug, 10);
      strapi.log.info(`[Product.findBySlug] Attempting ID-based lookup for product ID: ${productId}`);

      const idFilters: any = {
        id: productId,
        removedAt: { $null: true },
      };

      if (!isAdmin) {
        idFilters.Status = "Active";
      }

      const productsById = await strapi.entityService.findMany("api::product.product", {
        filters: idFilters,
        populate,
        pagination: { limit: 1 },
      });

      const productById = (productsById as unknown[])[0] || null;
      if (productById) {
        strapi.log.info(`[Product.findBySlug] Found product by ID: ${productId}`);
        return productById;
      }

      strapi.log.warn(
        `[Product.findBySlug] Product with ID ${productId} not found or is trashed`,
      );
    } else {
      strapi.log.warn(
        `[Product.findBySlug] Slug "${decodedSlug}" is not numeric, cannot use ID fallback`,
      );
    }
  }

  return product;
}

export default factories.createCoreController(
  "api::product.product",
  ({ strapi }) => ({
    async generateVariationCombinations(ctx) {
      try {
        const result = await generateVariationCombinations(
          strapi,
          ctx.params?.id,
          ctx.request?.body?.axes,
        );
        ctx.body = { data: result };
      } catch (error) {
        strapi.log.warn("Product variation combination generation rejected", {
          productId: ctx.params?.id,
          error: (error as Error).message,
        });
        return ctx.badRequest("Variation combinations could not be generated", {
          data: { code: "VARIATION_COMBINATIONS_REJECTED" },
          error: (error as Error).message,
        });
      }
    },

    /**
     * Apply public-only filters for non-admin users
     * Ensures drafts/removed products are hidden from non-admins
     */
    applyPublicProductFilters(ctx) {
      const user = ctx.state.user;
      const isAdmin = isAdminUser(user);
      if (isAdmin) {
        return false;
      }

      const existingFilters = ctx.query?.filters || {};
      const andConditions: any[] = [];

      // Preserve existing $and + other filters
      if (existingFilters.$and) {
        andConditions.push(...existingFilters.$and);
        const { $and, ...rest } = existingFilters;
        if (Object.keys(rest).length) {
          andConditions.push(rest);
        }
      } else if (Object.keys(existingFilters).length) {
        andConditions.push(existingFilters);
      }

      andConditions.push({ removedAt: { $null: true } });
      andConditions.push({ Status: "Active" });

      ctx.query = {
        ...ctx.query,
        filters: {
          $and: andConditions,
        },
      };

      return true;
    },

    async find(ctx, next) {
      const view = String(ctx.query?.view || "");
      const isCardView = view === "card";

      // @ts-expect-error Strapi controller typings require two args; we only need ctx for filtering
      this.applyPublicProductFilters(ctx);

      if (isCardView) {
        const { view: _view, populate: _populate, fields: _fields, ...restQuery } = ctx.query || {};
        const productService: any = strapi.service("api::product.product");

        // Delegate to the stock-aware query (in-stock products first, computed
        // at the SQL level), preserving the secondary sort within each group.
        return productService.findProductCards({
          filters: restQuery.filters,
          sort: restQuery.sort,
          availability: restQuery.availability,
          price: restQuery.price,
          hasDiscount: restQuery.hasDiscount,
          requireCoverImage: restQuery.requireCoverImage,
          pagination: restQuery.pagination,
        });
      }

      const response = await (super.find as any)(ctx, next);

      return response;
    },

    async homepageSections(ctx) {
      try {
        const user = ctx.state.user;
        const isAdmin = isAdminUser(user);
        const bypassCache =
          shouldBypassEndpointCache(ctx.request?.headers as Record<string, unknown>) || isAdmin;

        const cacheKey = buildCacheKey({
          routeId: "product.homepage-sections",
          query: ctx.query || {},
          locale: String(ctx.query?.locale || ""),
          authSegment: bypassCache ? "auth" : "anon",
        });

        const payload = await withCache(
          {
            key: cacheKey,
            ttlSec: getCacheTtlFromEnv("CACHE_TTL_HOMEPAGE_SECTIONS_SEC", 90),
            bypass: bypassCache,
            onStatus: (status) => setCacheHeaderIfEnabled(ctx, status),
            shouldCacheValue: (value) => Array.isArray((value as any)?.data?.sections),
          },
          async () => strapi.service("api::product.product").findHomepageSections(),
        );

        return payload;
      } catch (error) {
        strapi.log.error("[Product.homepageSections] Error building homepage sections:", error);
        return ctx.badRequest("An error occurred while building homepage sections", {
          error: (error as Error).message,
        });
      }
    },

    async searchwiseFeed(ctx) {
      try {
        if (!isSearchwiseAuthorized(readSearchwiseHeaders(ctx))) {
          return ctx.unauthorized("Unauthorized");
        }

        const payload = await withCache(
          {
            key: buildCacheKey({
              routeId: "product.searchwise-feed",
              query: ctx.query || {},
              locale: String(ctx.query?.locale || ""),
            }),
            ttlSec: searchwiseCacheTtl(),
            onStatus: (status) => setCacheHeaderIfEnabled(ctx, status),
            shouldCacheValue: (value) => Array.isArray((value as any)?.data),
          },
          async () => buildSearchwiseFeedPayload(await findAllSearchwiseProducts(strapi)),
        );

        return payload;
      } catch (error) {
        strapi.log.error("[Product.searchwiseFeed] Error building Searchwise feed:", error);
        return ctx.badRequest("An error occurred while building the Searchwise feed", {
          error: (error as Error).message,
        });
      }
    },

    async searchwiseFeedItems(ctx) {
      try {
        if (!isSearchwiseAuthorized(readSearchwiseHeaders(ctx))) {
          return ctx.unauthorized("Unauthorized");
        }

        const page = parseSearchwisePage(ctx.query?.page);
        const size = parseSearchwiseSize(ctx.query?.size);

        const payload = await withCache(
          {
            key: buildCacheKey({
              routeId: "product.searchwise-feed.items",
              query: { page, size },
              locale: String(ctx.query?.locale || ""),
            }),
            ttlSec: searchwiseCacheTtl(),
            onStatus: (status) => setCacheHeaderIfEnabled(ctx, status),
            shouldCacheValue: (value) => Array.isArray((value as any)?.data),
          },
          async () => {
            const { products, pagination } = await findSearchwiseProductsPage(strapi, page, size);
            return buildSearchwiseFeedPayload(products, pagination);
          },
        );

        return payload;
      } catch (error) {
        strapi.log.error("[Product.searchwiseFeedItems] Error building Searchwise page:", error);
        return ctx.badRequest("An error occurred while building the Searchwise feed page", {
          error: (error as Error).message,
        });
      }
    },

    async searchwiseFeedItem(ctx) {
      try {
        if (!isSearchwiseAuthorized(readSearchwiseHeaders(ctx))) {
          return ctx.unauthorized("Unauthorized");
        }

        const idOrSlug = String(ctx.params?.idOrSlug || "").trim();
        if (!idOrSlug) {
          return ctx.badRequest("Product id or slug is required");
        }

        let decoded = idOrSlug;
        try {
          decoded = decodeURIComponent(idOrSlug);
        } catch {
          decoded = idOrSlug;
        }

        const isId = /^\d+$/.test(decoded);
        const filters = {
          ...SEARCHWISE_PRODUCT_FILTERS,
          ...(isId ? { id: Number(decoded) } : { Slug: { $eq: decoded } }),
        };

        const payload = await withCache(
          {
            key: buildCacheKey({
              routeId: "product.searchwise-feed.item",
              params: { idOrSlug: decoded },
              locale: String(ctx.query?.locale || ""),
            }),
            ttlSec: searchwiseCacheTtl(),
            onStatus: (status) => setCacheHeaderIfEnabled(ctx, status),
            shouldCacheValue: (value) => Boolean((value as any)?.data?.[0]),
          },
          async () => {
            const products = await strapi.entityService.findMany("api::product.product", {
              filters,
              populate: SEARCHWISE_PRODUCT_POPULATE,
              sort: { updatedAt: "desc" },
              limit: 1,
            });
            return buildSearchwiseFeedPayload(products);
          },
        );

        if (!payload?.data?.[0]) {
          return ctx.notFound("Product not found");
        }

        return { data: payload.data[0], meta: payload.meta };
      } catch (error) {
        strapi.log.error("[Product.searchwiseFeedItem] Error building Searchwise product:", error);
        return ctx.badRequest("An error occurred while building the Searchwise product", {
          error: (error as Error).message,
        });
      }
    },

    async findOne(ctx, next) {
      // @ts-expect-error Strapi controller typings require two args; we only need ctx for filtering
      const filtersApplied = this.applyPublicProductFilters(ctx);
      const response: any = await (super.findOne as any)(ctx, next);

      if (!filtersApplied) {
        return response;
      }

      const product = response?.data;
      const status = readProductStatus(product);
      const removedAt = readProductRemovedAt(product);
      if (status !== "Active" || removedAt) {
        return ctx.notFound("Product not found");
      }

      const user = ctx.state.user;
      const isAdmin = isAdminUser(user);
      if (!isAdmin && status === "Active" && product?.id) {
        try {
          const productViewService = strapi.service("api::product-view.product-view") as {
            queueProductView: (productId: number) => Promise<void>;
          };
          void productViewService.queueProductView(product.id);
        } catch (viewError) {
          strapi.log.warn("[Product.findOne] Failed to queue view count increment:", viewError);
        }
      }

      return response;
    },

    /**
     * Search products by query string
     * @param {Object} ctx - The context
     * @returns {Object} The search results
     */
    async search(ctx) {
      try {
        const { q } = ctx.query;

        if (!q) {
          return ctx.badRequest("Search query (q) is required");
        }

        const user = ctx.state.user;
        const isAdmin = isAdminUser(user);
        const bypassCache = shouldBypassEndpointCache(ctx.request?.headers as Record<string, unknown>) || isAdmin;

        const cacheKey = buildCacheKey({
          routeId: "product.search",
          query: ctx.query || {},
          locale: String(ctx.query?.locale || ""),
          authSegment: bypassCache ? "auth" : "anon",
        });

        const payload = await withCache(
          {
            key: cacheKey,
            ttlSec: getCacheTtlFromEnv("CACHE_TTL_PRODUCT_SEARCH_SEC", 20),
            bypass: bypassCache,
            onStatus: (status) => setCacheHeaderIfEnabled(ctx, status),
            shouldCacheValue: (value) => Array.isArray((value as any)?.data),
          },
          async () => {
            const { results, pagination } = await strapi
              .service("api::product.product")
              .search(q, { ...ctx.query, isAdmin });

            const productService: any = strapi.service("api::product.product");
            const resultList = Array.isArray(results) ? results : [];
            return {
              data:
                ctx.query?.view === "card" || ctx.query?.view === "suggestion"
                  ? resultList
                  : resultList.filter((p: any) =>
                      productService.hasPublishedStockedVariation(
                        p?.attributes ? { product_variations: p.attributes.product_variations?.data } : p,
                      ),
                    ),
              meta: { pagination },
            };
          },
        );

        return payload;
      } catch (error) {
        return ctx.badRequest("An error occurred while searching products", {
          error: (error as Error).message,
        });
      }
    },

    /**
     * Find a product by its slug
     * @param {Object} ctx - The context
     * @returns {Object} The product data
     */
    async findBySlug(ctx) {
      try {
        const { slug } = ctx.params;

        if (!slug) {
          return ctx.badRequest("Slug parameter is required");
        }

        let decodedSlug = slug;
        try {
          decodedSlug = decodeURIComponent(slug);
        } catch {
          decodedSlug = slug;
        }

        strapi.log.info(
          `[Product.findBySlug] Looking up product with slug/ID: "${decodedSlug}" (original: "${slug}")`,
        );

        const user = ctx.state.user;
        const isAdmin = isAdminUser(user);
        const bypassCache = shouldBypassEndpointCache(ctx.request?.headers as Record<string, unknown>) || isAdmin;
        const populate = getProductPopulateForView(ctx.query?.view);

        const cacheKey = buildCacheKey({
          routeId: "product.by-slug",
          params: { slug: decodedSlug },
          query: ctx.query || {},
          locale: String(ctx.query?.locale || ""),
          authSegment: bypassCache ? "auth" : "anon",
        });

        const payload = await withCache(
          {
            key: cacheKey,
            ttlSec: getCacheTtlFromEnv("CACHE_TTL_PRODUCT_BY_SLUG_SEC", 60),
            bypass: bypassCache,
            onStatus: (status) => setCacheHeaderIfEnabled(ctx, status),
            shouldCacheValue: (value) => Boolean((value as any)?.data),
          },
          async () => {
            const product = await findProductBySlugInternal(strapi, decodedSlug, isAdmin, populate);
            if (!product) {
              return null;
            }
            return { data: product };
          },
        );

        if (!payload?.data) {
          strapi.log.error(`[Product.findBySlug] Product not found for slug/ID: ${decodedSlug}`);
          return ctx.notFound("Product not found");
        }

        const productData = payload.data;
        const status = readProductStatus(productData);
        const removedAt = readProductRemovedAt(productData);
        if (!isAdmin && (status !== "Active" || removedAt)) {
          return ctx.notFound("Product not found");
        }

        strapi.log.info(
          `[Product.findBySlug] Successfully found product: ${productData.id} (${productData.Title || "N/A"})`,
        );

        if (!isAdmin && status === "Active" && productData?.id) {
          try {
            const productViewService = strapi.service("api::product-view.product-view") as {
              queueProductView: (productId: number) => Promise<void>;
            };
            void productViewService.queueProductView(Number(productData.id));
          } catch (viewError) {
            strapi.log.warn("[Product.findBySlug] Failed to queue view count increment:", viewError);
          }
        }

        return payload;
      } catch (error) {
        strapi.log.error("[Product.findBySlug] Error finding product by slug:", error);
        return ctx.badRequest("An error occurred while finding the product", {
          error: (error as Error).message,
        });
      }
    },
  }),
);
