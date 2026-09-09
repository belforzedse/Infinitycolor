// @ts-nocheck
/**
 * product controller
 */

import { factories } from "@strapi/strapi";
import { hasCapability, normalizeAdminRole } from "@repo/auth-core";
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
import { isTrustedWordPressMigrationRequest } from "../../../utils/migration-context";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";
import { buildProductSlugCandidates } from "../../../utils/productSlugCandidates";
import { resolveAdminActor } from "../../../utils/adminAuthorization";
import {
  executePublicationCommand,
  PublicationCommandError,
  runPublicationEffects,
} from "../services/product-publication";
import {
  enqueueScheduledProductPublication,
  removeScheduledProductPublication,
} from "../../../queue/product-publication-queue";

const OPERATIONAL_PRODUCT_FIELDS = [
  "Title",
  "Slug",
  "Weight",
  "CoverImage",
  "Description",
  "ProductType",
  "IsSimpleProduct",
  "Media",
  "product_main_category",
  "product_tags",
  "product_attribute_assignments",
  "owned_product_attributes",
  "Files",
  "product_size_helper",
  "CleaningTips",
  "ReturnConditions",
  "product_faqs",
  "product_other_categories",
  "discounts",
] as const;

const PUBLICATION_CONTROL_FIELDS = new Set([
  "Status",
  "scheduledPublishAt",
  "scheduledPublishTimezone",
  "scheduledPublishRequireMedia",
  "scheduledPublishRevision",
  "scheduledPublishLastAttemptAt",
  "scheduledPublishLastError",
  "scheduledPublishFailureKind",
  "scheduledPublishAttemptCount",
  "scheduledPublishNextRetryAt",
  "publicationRevision",
  "publicationEffectsCompletedRevision",
  "publicationEffectsLastError",
]);

function rejectPublicationFields(ctx: any): boolean {
  const data = ctx.request?.body?.data;
  if (!data || typeof data !== "object") return false;
  const found = Object.keys(data).filter((field) => PUBLICATION_CONTROL_FIELDS.has(field));
  if (found.length === 0) return false;
  ctx.status = 400;
  ctx.body = {
    error: {
      status: 400,
      name: "PublicationCommandRequired",
      message: "Publication state must be changed through /products/:id/publication",
      details: { code: "PUBLICATION_COMMAND_REQUIRED", fields: found },
    },
  };
  return true;
}

function discardLegacyDraftStatusOnCreate(ctx: any): void {
  const data = ctx.request?.body?.data;
  if (!data || typeof data !== "object" || data.Status !== "InActive") return;

  // Older admin releases included the default draft status in the generic
  // create payload. Accept that one safe legacy value during rolling deploys;
  // this controller still forces every new product to InActive below. All
  // other publication values and fields remain command-only.
  const { Status: _legacyDraftStatus, ...operationalData } = data;
  ctx.request.body = { ...ctx.request.body, data: operationalData };
}

/**
 * Check whether the user can access operational catalog records, including
 * inactive and soft-deleted products.
 * Supports both plugin::users-permissions.user roles and local-user roles
 * @param user - The user object from ctx.state.user
 * @returns true if user is an admin, false otherwise
 */
function isAdminUser(user: any): boolean {
  if (!user) return false;
  const role = normalizeAdminRole(user?.role?.type) ?? normalizeAdminRole(user?.role?.name);
  return role ? hasCapability(role, "product.read") : false;
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
    filters: { Status: "Accepted", removedAt: { $null: true } },
    populate: {
      user: {
        fields: ["id"],
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
  return String(view || "")
    .trim()
    .toLowerCase() === "shell"
    ? PRODUCT_SHELL_POPULATE
    : PRODUCT_POPULATE;
}

function isUnrestrictedAdminUser(user: any): boolean {
  return (
    normalizeAdminRole(user?.role?.type) ?? normalizeAdminRole(user?.role?.name)
  ) === "superadmin";
}

async function loadProductById(
  strapi: any,
  productId: number,
  isAdmin: boolean,
  populate: typeof PRODUCT_POPULATE | typeof PRODUCT_SHELL_POPULATE,
): Promise<any | null> {
  const foundFilters: any = {
    id: productId,
    removedAt: { $null: true },
  };
  if (!isAdmin) {
    foundFilters.Status = "Active";
  }
  const foundProducts = await strapi.entityService.findMany("api::product.product", {
    filters: foundFilters,
    populate,
    pagination: { limit: 1 },
  });
  return (foundProducts as unknown[])[0] || null;
}

async function findProductBySlugInternal(
  strapi: any,
  inboundSlug: string,
  isAdmin: boolean,
  populate: typeof PRODUCT_POPULATE | typeof PRODUCT_SHELL_POPULATE = PRODUCT_POPULATE,
): Promise<any | null> {
  // Try every encoding/normalization of the inbound slug in one query. Historical
  // imports stored WooCommerce's percent-encoded form verbatim; the storefront
  // always sends the decoded Persian form. Matching only one of those meant
  // ~half the catalog was unreachable from every URL shape.
  const candidates = buildProductSlugCandidates(inboundSlug);
  const filters: any = {
    Slug: { $in: candidates },
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
      `[Product.findBySlug] No match for slug candidates of: "${inboundSlug}", trying raw SQL…`,
    );
    try {
      const knex = strapi.db.connection;
      let rawQuery = knex("products").whereIn("slug", candidates).whereNull("removed_at");

      if (!isAdmin) {
        rawQuery = rawQuery.where("status", "Active");
      }

      const rawProducts = await rawQuery.limit(1);
      if (rawProducts.length > 0) {
        const productId = rawProducts[0].id;
        product = await loadProductById(strapi, productId, isAdmin, populate);
        if (product) {
          strapi.log.info(`[Product.findBySlug] Found product via raw SQL query: ${productId}`);
        }
      }
    } catch (sqlError) {
      strapi.log.warn("[Product.findBySlug] Raw SQL query failed:", sqlError);
    }
  }

  // Prior slug forms (e.g. percent-encoded imports after repair, or a renamed
  // slug) live in ProductSlugAlias and permanently resolve to the product.
  if (!product) {
    try {
      const aliases = await strapi.entityService.findMany(
        "api::product-slug-alias.product-slug-alias",
        {
          filters: { Slug: { $in: candidates } },
          populate: { product: true },
          pagination: { limit: 1 },
        },
      );
      const alias = (aliases as any[])[0];
      const aliasProductId = alias?.product?.id ?? alias?.product;
      if (aliasProductId) {
        product = await loadProductById(strapi, Number(aliasProductId), isAdmin, populate);
        if (product) {
          strapi.log.info(
            `[Product.findBySlug] Found product ${aliasProductId} via slug alias "${alias.Slug}"`,
          );
        }
      }
    } catch (aliasError) {
      strapi.log.warn("[Product.findBySlug] Slug alias lookup failed:", aliasError);
    }
  }

  if (!product) {
    const idMatch = inboundSlug.match(/^\d+$/);
    if (idMatch) {
      const productId = parseInt(inboundSlug, 10);
      strapi.log.info(
        `[Product.findBySlug] Attempting ID-based lookup for product ID: ${productId}`,
      );

      const productById = await loadProductById(strapi, productId, isAdmin, populate);
      if (productById) {
        strapi.log.info(`[Product.findBySlug] Found product by ID: ${productId}`);
        return productById;
      }
    }
  }

  return product;
}

export default factories.createCoreController("api::product.product", ({ strapi }) => ({
  async create(ctx) {
    discardLegacyDraftStatusOnCreate(ctx);
    if (rejectPublicationFields(ctx)) return;
    if (!(await enforceOperationalDataFields(ctx, strapi, OPERATIONAL_PRODUCT_FIELDS))) return;
    ctx.request.body = ctx.request.body || {};
    ctx.request.body.data = { ...(ctx.request.body.data || {}), Status: "InActive" };
    return super.create(ctx);
  },

  async update(ctx) {
    if (rejectPublicationFields(ctx)) return;
    if (!(await enforceOperationalDataFields(ctx, strapi, OPERATIONAL_PRODUCT_FIELDS))) return;
    return super.update(ctx);
  },

  async updateDisplayDate(ctx) {
    const productId = Number(ctx.params?.id);
    const displayAt = ctx.request?.body?.data?.displayAt;
    const parsedDisplayAt = typeof displayAt === "string" ? new Date(displayAt) : null;

    if (
      !Number.isSafeInteger(productId) ||
      productId <= 0 ||
      !parsedDisplayAt ||
      Number.isNaN(parsedDisplayAt.getTime())
    ) {
      ctx.status = 400;
      ctx.body = {
        error: {
          code: "INVALID_PRODUCT_DISPLAY_DATE",
          message: "A valid product ID and display date are required",
        },
      };
      return;
    }

    const normalizedDisplayAt = parsedDisplayAt.toISOString();
    const product = await strapi.entityService.update("api::product.product", productId, {
      data: { LastEditedByAdminAt: normalizedDisplayAt },
    });

    ctx.body = {
      data: {
        id: product.id,
        LastEditedByAdminAt: normalizedDisplayAt,
      },
    };
  },

  async publication(ctx) {
    const trustedImporter = isTrustedWordPressMigrationRequest();
    let user = ctx.state?.user;
    const body = ctx.request?.body?.data || ctx.request?.body || {};
    const action = String(body.action || "");
    const requiredCapability = ["schedule", "retry", "cancel"].includes(action)
      ? "product.schedule"
      : "product.publish";
    if (!trustedImporter) {
      const adminActor = await resolveAdminActor(strapi, user);
      if (!adminActor || !hasCapability(adminActor.role, requiredCapability)) {
        return ctx.forbidden("Publication action is not allowed", {
          code: "PUBLICATION_FORBIDDEN",
        });
      }
      user = adminActor.user;
    }

    const productId = Number(ctx.params?.id);
    const command = {
      action,
      publishAt: body.publishAt,
      timezone: body.timezone,
      requireMedia: trustedImporter ? body.requireMedia === true : false,
      expectedExternalSource: body.expectedExternalSource,
      expectedExternalId: body.expectedExternalId,
    } as any;

    if (trustedImporter) {
      if (
        command.expectedExternalSource !== "woocommerce" ||
        !String(command.expectedExternalId || "").trim()
      ) {
        ctx.status = 400;
        ctx.body = { error: { code: "EXTERNAL_PRODUCT_IDENTITY_REQUIRED" } };
        return;
      }
    }

    const actor = user?.id
      ? {
          id: Number(user.id),
          name: user.username || user.email || null,
          role: user.role?.name || null,
          ip: ctx.request?.ip || ctx.ip || null,
          userAgent: ctx.request?.headers?.["user-agent"] || null,
        }
      : undefined;

    try {
      const result = await executePublicationCommand(strapi, productId, command, {
        origin: trustedImporter ? "importer" : "admin",
        actor,
      });
      let queueState = "not-required";

      if ((action === "schedule" || action === "retry") && result.scheduledPublishAt) {
        try {
          await enqueueScheduledProductPublication({
            productId,
            scheduleRevision: result.scheduleRevision,
            expectedPublishAt: result.scheduledPublishAt,
            auditContext: result.auditJobContext,
          });
          queueState = "queued";
        } catch (error) {
          queueState = "pending-reconciliation";
          strapi.log.error("[product-publication] delayed job enqueue failed", {
            productId,
            scheduleRevision: result.scheduleRevision,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (result.previousScheduleRevision) {
        await removeScheduledProductPublication(productId, result.previousScheduleRevision);
      }

      if (result.needsPublicationEffects) {
        try {
          await runPublicationEffects(strapi, productId, result.publicationRevision);
        } catch {
          queueState = "pending-reconciliation";
        }
      }

      ctx.body = {
        data: {
          id: result.productId,
          Status: result.status,
          scheduledPublishAt: result.scheduledPublishAt,
          scheduledPublishTimezone: result.scheduledPublishTimezone,
          scheduledPublishRevision: result.scheduleRevision,
          publicationRevision: result.publicationRevision,
          queueState,
          changed: result.changed,
        },
      };
    } catch (error) {
      if (error instanceof PublicationCommandError) {
        ctx.status = error.status;
        ctx.body = {
          error: {
            status: error.status,
            name: "PublicationCommandError",
            message: error.code,
            details: { code: error.code },
          },
        };
        return;
      }
      strapi.log.error("[product-publication] command failed", {
        productId,
        action,
        error: error instanceof Error ? error.message : String(error),
      });
      ctx.status = 500;
      ctx.body = { error: { code: "PUBLICATION_COMMAND_FAILED" } };
    }
  },

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
    // A fully trusted migration request must see an existing inactive product
    // by external_id so the idempotent importer updates it instead of trying a
    // duplicate create. Trashed products remain excluded.
    if (!isTrustedWordPressMigrationRequest()) {
      andConditions.push({ Status: "Active" });
    }

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

    const user = ctx.state.user;
    if (isAdminUser(user) && !isUnrestrictedAdminUser(user)) {
      const query = (ctx.query || {}) as any;
      ctx.query = {
        filters: query.filters,
        sort: query.sort,
        pagination: query.pagination,
        locale: query.locale,
        populate: PRODUCT_SHELL_POPULATE,
      } as any;
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
    const user = ctx.state.user;
    if (isAdminUser(user) && !isUnrestrictedAdminUser(user)) {
      ctx.query = {
        filters: (ctx.query as any)?.filters,
        locale: (ctx.query as any)?.locale,
        populate: PRODUCT_SHELL_POPULATE,
      } as any;
    }
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
      const bypassCache =
        shouldBypassEndpointCache(ctx.request?.headers as Record<string, unknown>) || isAdmin;

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
                      p?.attributes
                        ? { product_variations: p.attributes.product_variations?.data }
                        : p,
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
      const bypassCache =
        shouldBypassEndpointCache(ctx.request?.headers as Record<string, unknown>) || isAdmin;
      const populate =
        isAdmin && !isUnrestrictedAdminUser(user)
          ? PRODUCT_SHELL_POPULATE
          : getProductPopulateForView(ctx.query?.view);

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
      // 503, not 400. Any throw here is an infrastructure fault (DB timeout,
      // connection loss, serialization error) — never evidence that the product
      // does not exist. Returning a 4xx let the storefront classify a transient
      // backend failure as a durable "product not found" and cache it as one.
      ctx.status = 503;
      ctx.set("Retry-After", "5");
      ctx.body = {
        error: {
          status: 503,
          name: "ServiceUnavailable",
          message: "Product lookup temporarily unavailable",
        },
      };
      return;
    }
  },
}));
