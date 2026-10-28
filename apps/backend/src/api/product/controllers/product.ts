// @ts-nocheck
/**
 * product controller
 */

import { factories } from "@strapi/strapi";
import { validateProductOwnedRelations } from "../../../utils/catalogOwnership";
import { productEditorActions, saveProductEditor } from "./product-editor";
import {
  afterCatalogCommit,
  CatalogEditError,
  sendCatalogEditError,
} from "../../../utils/catalogEdit";
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
import {
  ColorReplaceError,
  replaceProductVariationColor,
} from "../services/variation-color-replace";
import { isTrustedWordPressMigrationRequest } from "../../../utils/migration-context";
import { enforceOperationalDataFields } from "../../../utils/operationalCommerce";
import { buildProductSlugCandidates } from "../../../utils/productSlugCandidates";
import { validateProductSlug } from "../../../utils/productSlug";
import {
  catalogProductFilters,
  isProductPubliclyVisible,
  isProductPurged,
  publicProductFilters,
  wherePublicProduct,
} from "../../../utils/productVisibility";
import { generateUnicodeSlug } from "../../../utils/unicodeSlug";
import { requireCapability, resolveAdminActor } from "../../../utils/adminAuthorization";
import { publicProductDiscoveryFilters } from "../../../utils/productDiscovery";
import { recordAdminAudit } from "../../../utils/adminAudit";
import {
  executePublicationCommand,
  PublicationCommandError,
  runPublicationEffects,
} from "../services/product-publication";
import {
  enqueueScheduledProductPublication,
  removeScheduledProductPublication,
} from "../../../queue/product-publication-queue";
import {
  BULK_ACTION_CAPABILITY,
  emptyTrash,
  parseBulkProductIds,
  purgeProduct,
  restoreProduct,
  runLifecycleBulk,
  trashProduct,
  type BulkLifecycleAction,
  type LifecycleActor,
  type LifecycleResult,
} from "../services/product-lifecycle";
import {
  createProductPreviewDraft,
  readProductPreviewDraft,
  sanitizeProductPreviewOverlay,
  type ProductPreviewOverlay,
} from "../services/product-preview-draft";
import { validateColorGalleriesInput } from "../services/product-color-galleries";
const OPERATIONAL_PRODUCT_FIELDS = [
  "Title",
  "Slug",
  "Weight",
  "CoverImage",
  "Description",
  "ProductType",
  "IsSimpleProduct",
  "Media",
  "ColorGalleries",
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
  "EditRevision",
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

/**
 * Trash and permanent deletion are commands with their own capabilities, audit
 * and cache effects (services/product-lifecycle.ts). Their columns are never
 * writable through the generic create/update path, for any role.
 */
const LIFECYCLE_CONTROL_FIELDS = new Set([
  "removedAt",
  "removedById",
  "removedByLabel",
  "preRemovalStatus",
  "preRemovalScheduledPublishAt",
  "purgedAt",
  "purgedById",
]);

function rejectLifecycleFields(ctx: any): boolean {
  const data = ctx.request?.body?.data;
  if (!data || typeof data !== "object") return false;
  const found = Object.keys(data).filter((field) => LIFECYCLE_CONTROL_FIELDS.has(field));
  if (found.length === 0) return false;
  ctx.status = 400;
  ctx.body = {
    error: {
      status: 400,
      name: "LifecycleCommandRequired",
      message: "Trash state must be changed through the product lifecycle routes",
      details: { code: "LIFECYCLE_COMMAND_REQUIRED", fields: found },
    },
  };
  return true;
}

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

/**
 * When an admin submits a `Slug` explicitly (rather than leaving it to be
 * auto-generated from the Title), sanitize it through the same pipeline as
 * generated slugs and reject it if it collides with a reserved route or
 * another product. Passing an empty/whitespace value removes the field from
 * the payload instead of writing an empty string, since `beforeUpdate` only
 * auto-generates a replacement when `data.Slug` is entirely absent.
 */
async function rejectInvalidManualSlug(ctx: any, strapi: any): Promise<boolean> {
  const data = ctx.request?.body?.data;
  if (!data || typeof data !== "object" || !("Slug" in data)) return false;

  const rawSlug = data.Slug;
  if (rawSlug === null || rawSlug === undefined || typeof rawSlug !== "string") {
    delete data.Slug;
    return false;
  }

  const normalizedSlug = generateUnicodeSlug(rawSlug, "product-slug");
  if (!rawSlug.trim()) {
    delete data.Slug;
    return false;
  }

  const productId = Number(ctx.params?.id);
  const { isValid, error } = await validateProductSlug(
    strapi,
    normalizedSlug,
    Number.isFinite(productId) ? productId : undefined,
  );
  if (!isValid) {
    ctx.badRequest(error || "Invalid slug");
    return true;
  }

  data.Slug = normalizedSlug;
  return false;
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
  ColorGalleries: {
    populate: {
      color: true,
      Images: true,
    },
  },
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
  ColorGalleries: {
    populate: {
      color: true,
      Images: true,
    },
  },
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
    (normalizeAdminRole(user?.role?.type) ?? normalizeAdminRole(user?.role?.name)) === "superadmin"
  );
}

async function loadProductById(
  strapi: any,
  productId: number,
  isAdmin: boolean,
  populate: typeof PRODUCT_POPULATE | typeof PRODUCT_SHELL_POPULATE,
): Promise<any | null> {
  const foundFilters: any = {
    id: productId,
    ...catalogProductFilters(isAdmin),
  };
  const foundProducts = await strapi.entityService.findMany("api::product.product", {
    filters: foundFilters,
    populate,
    pagination: { limit: 1 },
  });
  return (foundProducts as unknown[])[0] || null;
}

/**
 * Splices an admin's unsaved form edits onto a live product fetched via
 * `loadProductById`, in place.
 *
 * `entityService.findMany`/`findOne` return the pre-serialization shape —
 * flat fields and flat relations (see `updateDisplayDate` above reading
 * `existing.LastEditedByAdminAt` directly off a findOne result, with no
 * `.attributes`). Strapi's own content-API response pipeline wraps this into
 * `{ data: { attributes } }` on the way out over HTTP, the same as it does
 * for the untouched fields on this same object — so every write here must
 * also be flat, never `{ data }`, or it gets double-wrapped and the frontend
 * (whose `normalizeRelation` passes an already-`.data`-shaped value through
 * untouched) renders `data.attributes === undefined`.
 *
 * Still reads defensively via `attrs ?? product`/`.attributes ?? entity`,
 * matching this codebase's own `attrsOf`/`relationData` idiom
 * (api/product/services/product.ts), in case a future Strapi/config change
 * ever hands this a wrapped shape instead.
 *
 * Product-level relation fields not covered by the admin form (reviews,
 * FAQs, size helper, attribute assignments) are left as the live DB fetched
 * them — the overlay only ever contains what `EditProductData` can edit.
 */
async function applyPreviewOverlay(
  strapi: any,
  product: any,
  overlay: ProductPreviewOverlay,
): Promise<void> {
  const attrs = product?.attributes ?? product;
  if (!attrs) return;

  if (overlay.Title !== undefined) attrs.Title = overlay.Title;
  if (overlay.Description !== undefined) attrs.Description = overlay.Description;
  if (overlay.Status !== undefined) attrs.Status = overlay.Status;

  if (overlay.coverImageId !== undefined) {
    attrs.CoverImage = overlay.coverImageId
      ? await strapi.entityService.findOne("plugin::upload.file", overlay.coverImageId)
      : null;
  }

  if (overlay.mediaIds !== undefined) {
    attrs.Media = await Promise.all(
      overlay.mediaIds.map((id) => strapi.entityService.findOne("plugin::upload.file", id)),
    );
  }

  if (overlay.fileIds !== undefined) {
    attrs.Files = await Promise.all(
      overlay.fileIds.map((id) => strapi.entityService.findOne("plugin::upload.file", id)),
    );
  }

  if (overlay.mainCategoryId !== undefined) {
    attrs.product_main_category = overlay.mainCategoryId
      ? await strapi.entityService.findOne(
          "api::product-category.product-category",
          overlay.mainCategoryId,
        )
      : null;
  }

  if (overlay.otherCategoryIds !== undefined) {
    attrs.product_other_categories = await Promise.all(
      overlay.otherCategoryIds.map((id) =>
        strapi.entityService.findOne("api::product-category.product-category", id),
      ),
    );
  }

  if (overlay.tagIds !== undefined) {
    attrs.product_tags = await Promise.all(
      overlay.tagIds.map((id) => strapi.entityService.findOne("api::product-tag.product-tag", id)),
    );
  }

  if (
    overlay.simpleVariationId &&
    (overlay.simplePrice !== undefined ||
      overlay.simpleDiscountPrice !== undefined ||
      overlay.simpleStock !== undefined)
  ) {
    const variationList = Array.isArray(attrs.product_variations)
      ? attrs.product_variations
      : (attrs.product_variations?.data ?? []);
    const variation = variationList.find((v: any) => v.id === overlay.simpleVariationId);
    const variationAttrs = variation?.attributes ?? variation;

    if (variationAttrs) {
      if (overlay.simplePrice !== undefined) variationAttrs.Price = overlay.simplePrice;
      if (overlay.simpleDiscountPrice !== undefined) {
        variationAttrs.DiscountPrice = overlay.simpleDiscountPrice;
      }
      if (overlay.simpleStock !== undefined) {
        const stock = variationAttrs.product_stock?.data ?? variationAttrs.product_stock;
        const stockAttrs = stock?.attributes ?? stock;
        if (stockAttrs) stockAttrs.Count = overlay.simpleStock;
      }
    }
  }
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
    ...catalogProductFilters(isAdmin),
  };

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
      let rawQuery = knex("products").whereIn("slug", candidates);
      rawQuery = isAdmin ? rawQuery.whereNull("removed_at") : wherePublicProduct(rawQuery);

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

type LifecycleHttpActor = {
  actor: LifecycleActor;
  /** What this caller holds: a role's capabilities, or only the one a service token was checked for. */
  capabilities: readonly string[];
};

function adminActorLabel(user: any): string | null {
  const info = user?.user_info || {};
  const fullName = [info.FirstName, info.LastName]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  return fullName || user?.username || user?.phone || user?.email || null;
}

/**
 * Authorizes a lifecycle request through the same `requireCapability` every
 * capability-gated route uses — so a refusal is answered and audited as
 * `security.access_denied`, and API tokens follow the shared token rules — and
 * returns who acted, for attribution (removedBy, audit actor, Undo).
 *
 * Routes with a capability policy have already run this check; running it
 * again here is idempotent and is what the bulk route and the core DELETE
 * (whose capability depends on the request) rely on.
 */
async function authorizeLifecycle(
  ctx: any,
  strapi: any,
  capability: string,
): Promise<LifecycleHttpActor | null> {
  const adminActor = await requireCapability(ctx, strapi, capability as any);
  if (!adminActor) return null;
  const user = adminActor.user;
  // A service token is not a person: never record its token id as a user id.
  const isService = user?.role?.type === "service";
  return {
    capabilities: adminActor.capabilities,
    actor: {
      id: isService ? 0 : Number(user.id),
      name: user.username || user.email || null,
      label: adminActorLabel(user),
      role: user.role?.name || null,
      ip: ctx.request?.ip || ctx.ip || null,
      userAgent: ctx.request?.headers?.["user-agent"] || null,
    },
  };
}

function sendLifecycleError(ctx: any, strapi: any, error: unknown, label: string) {
  if (error instanceof CatalogEditError) {
    sendCatalogEditError(ctx, error);
    return;
  }
  if (error instanceof PublicationCommandError) {
    ctx.status = error.status;
    ctx.body = {
      error: {
        status: error.status,
        name: "ProductLifecycleError",
        message: error.code,
        details: { code: error.code },
      },
    };
    return;
  }
  strapi.log.error(`[product-lifecycle] ${label} failed`, {
    productId: ctx.params?.id,
    error: error instanceof Error ? error.message : String(error),
  });
  ctx.status = 500;
  ctx.body = {
    error: {
      status: 500,
      name: "ProductLifecycleError",
      message: "LIFECYCLE_COMMAND_FAILED",
      details: { code: "LIFECYCLE_COMMAND_FAILED" },
    },
  };
}

function lifecycleResponse(result: LifecycleResult) {
  return {
    id: result.productId,
    state: result.state,
    Status: result.status,
    removedAt: result.removedAt,
    previousStatus: result.previousStatus ?? null,
    warnings: result.warnings || [],
    /** True when the product was already in the requested state; nothing changed. */
    unchanged: !result.changed,
  };
}

async function runSingleLifecycleCommand(
  ctx: any,
  strapi: any,
  label: string,
  capability: string,
  command: (productId: number, http: LifecycleHttpActor) => Promise<LifecycleResult>,
) {
  const productId = Number(ctx.params?.id);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    ctx.status = 400;
    ctx.body = {
      error: {
        status: 400,
        name: "ProductLifecycleError",
        message: "INVALID_PRODUCT_ID",
        details: { code: "INVALID_PRODUCT_ID" },
      },
    };
    return;
  }
  const http = await authorizeLifecycle(ctx, strapi, capability);
  if (!http) return;
  try {
    const result = await command(productId, http);
    ctx.set("Cache-Control", "private, no-store");
    ctx.body = { data: lifecycleResponse(result) };
  } catch (error) {
    sendLifecycleError(ctx, strapi, error, label);
  }
}

export default factories.createCoreController("api::product.product", ({ strapi }) => ({
  ...productEditorActions(strapi),
  async editor(ctx) {
    if (ctx.request?.body?.data?.ColorGalleries !== undefined && !(await requireCapability(ctx, strapi, "product.media.manage"))) return;
    await validateProductOwnedRelations(
      strapi,
      Number(ctx.params.id),
      ctx.request?.body?.data || {},
    );
    if (rejectPublicationFields(ctx) || rejectLifecycleFields(ctx)) return;
    if (!(await enforceOperationalDataFields(ctx, strapi, OPERATIONAL_PRODUCT_FIELDS))) return;
    if (await rejectInvalidManualSlug(ctx, strapi)) return;
    const colorGalleries = ctx.request?.body?.data?.ColorGalleries;

    if (colorGalleries !== undefined) {
      await validateColorGalleriesInput(strapi, colorGalleries, Number(ctx.params.id));
    }

    return saveProductEditor(ctx, strapi, () => super.update(ctx));
  },
  async create(ctx) {
    if (ctx.request?.body?.data?.ColorGalleries !== undefined && !(await requireCapability(ctx, strapi, "product.media.manage"))) return;
    discardLegacyDraftStatusOnCreate(ctx);
    if (rejectPublicationFields(ctx)) return;
    if (rejectLifecycleFields(ctx)) return;
    if (!(await enforceOperationalDataFields(ctx, strapi, OPERATIONAL_PRODUCT_FIELDS))) return;
    if (await rejectInvalidManualSlug(ctx, strapi)) return;
    ctx.request.body = ctx.request.body || {};
    ctx.request.body.data = { ...(ctx.request.body.data || {}), Status: "InActive" };
    // Keep attachment locks through creation so deletion/replacement cannot
    // race with the new product's media associations.
    return strapi.db.transaction(async () => {
      await validateProductOwnedRelations(strapi, null, ctx.request.body.data);
      const colorGalleries = ctx.request?.body?.data?.ColorGalleries;

      if (colorGalleries !== undefined) {
        await validateColorGalleriesInput(strapi, colorGalleries);
      }
      return super.create(ctx);
    });
  },

  async update(ctx) {
    if (ctx.request?.body?.data?.ColorGalleries !== undefined && !(await requireCapability(ctx, strapi, "product.media.manage"))) return;
    await validateProductOwnedRelations(
      strapi,
      Number(ctx.params.id),
      ctx.request?.body?.data || {},
    );
    if (rejectPublicationFields(ctx)) return;
    if (rejectLifecycleFields(ctx)) return;
    if (!(await enforceOperationalDataFields(ctx, strapi, OPERATIONAL_PRODUCT_FIELDS))) return;
    if (await rejectInvalidManualSlug(ctx, strapi)) return;
    const colorGalleries = ctx.request?.body?.data?.ColorGalleries;

    if (colorGalleries !== undefined) {
      await validateColorGalleriesInput(strapi, colorGalleries, Number(ctx.params.id));
    }
    return super.update(ctx);
  },

  /**
   * Product lifecycle: Trash, restore/Undo and permanent deletion. Each route
   * carries its own capability policy (product.softDelete / product.restore /
   * product.delete); the state rules live in services/product-lifecycle.ts,
   * never here. `removedAt` and the other lifecycle columns are rejected on the
   * generic create/update path so no role can bypass these commands.
   */
  async softDelete(ctx) {
    return runSingleLifecycleCommand(
      ctx,
      strapi,
      "trash",
      "product.softDelete",
      (productId, http) => trashProduct(strapi, productId, { origin: "admin", actor: http.actor }),
    );
  },

  async restore(ctx) {
    const body = ctx.request?.body?.data || ctx.request?.body || {};
    const undoToken = typeof body.undoToken === "string" ? body.undoToken : null;
    return runSingleLifecycleCommand(ctx, strapi, "restore", "product.restore", (productId, http) =>
      restoreProduct(
        strapi,
        productId,
        { origin: "admin", actor: http.actor },
        {
          undoToken,
          // Undo may put a product back on the storefront, so it also needs the
          // capability that would have published or scheduled it.
          canPublish: http.capabilities.includes("product.publish"),
          canSchedule: http.capabilities.includes("product.schedule"),
        },
      ),
    );
  },

  async permanentDelete(ctx) {
    return runSingleLifecycleCommand(
      ctx,
      strapi,
      "permanent delete",
      "product.delete",
      (productId, http) => purgeProduct(strapi, productId, { origin: "admin", actor: http.actor }),
    );
  },

  /**
   * The core DELETE used to hard-delete any product. It now means the same as
   * permanent deletion: the product must already be in Trash and becomes a
   * tombstone, so order history and reports keep their product. Trusted
   * migration requests (the WooCommerce dedup script) keep the old row delete
   * for importer-made duplicates.
   */
  async delete(ctx) {
    if (isTrustedWordPressMigrationRequest()) {
      return (super.delete as any)(ctx);
    }
    return runSingleLifecycleCommand(
      ctx,
      strapi,
      "permanent delete",
      "product.delete",
      (productId, http) => purgeProduct(strapi, productId, { origin: "admin", actor: http.actor }),
    );
  },

  async bulkLifecycle(ctx) {
    const body = ctx.request?.body?.data || ctx.request?.body || {};
    const action = String(body.action || "") as BulkLifecycleAction;
    const capability = BULK_ACTION_CAPABILITY[action];
    const reject = (status: number, code: string) => {
      ctx.status = status;
      ctx.body = {
        error: { status, name: "ProductLifecycleError", message: code, details: { code } },
      };
    };
    if (!capability) return reject(400, "LIFECYCLE_ACTION_INVALID");

    // One route, many actions: the capability required is the requested action's.
    const http = await authorizeLifecycle(ctx, strapi, capability);
    if (!http) return;

    let ids: number[];
    try {
      ids = parseBulkProductIds(body.ids);
    } catch (error) {
      return sendLifecycleError(ctx, strapi, error, "bulk");
    }
    if (action === "schedule") {
      const publishAt = typeof body.publishAt === "string" ? body.publishAt : "";
      if (!publishAt || !(Date.parse(publishAt) > Date.now())) {
        return reject(422, "INVALID_PUBLICATION_TIME");
      }
    }

    try {
      const result = await runLifecycleBulk(
        strapi,
        action,
        ids,
        { origin: "admin", actor: http.actor },
        {
          publishAt: body.publishAt,
          timezone: body.timezone,
          undoToken: body.undoToken,
          canPublish: http.capabilities.includes("product.publish"),
          canSchedule: http.capabilities.includes("product.schedule"),
        },
      );
      ctx.set("Cache-Control", "private, no-store");
      ctx.body = { data: result };
    } catch (error) {
      sendLifecycleError(ctx, strapi, error, "bulk");
    }
  },

  async emptyTrash(ctx) {
    const body = ctx.request?.body?.data || ctx.request?.body || {};
    const trashedBefore = new Date(String(body.trashedBefore || ""));
    // The client sends when it loaded the Trash list; allow a little clock skew
    // but never a cut-off in the future that would sweep unseen products.
    if (
      Number.isNaN(trashedBefore.getTime()) ||
      trashedBefore.getTime() > Date.now() + 5 * 60 * 1000
    ) {
      ctx.status = 400;
      ctx.body = {
        error: {
          status: 400,
          name: "ProductLifecycleError",
          message: "TRASHED_BEFORE_INVALID",
          details: { code: "TRASHED_BEFORE_INVALID" },
        },
      };
      return;
    }
    const http = await authorizeLifecycle(ctx, strapi, "product.delete");
    if (!http) return;
    try {
      const result = await emptyTrash(
        strapi,
        { origin: "admin", actor: http.actor },
        { trashedBefore },
      );
      ctx.set("Cache-Control", "private, no-store");
      ctx.body = { data: result };
    } catch (error) {
      sendLifecycleError(ctx, strapi, error, "empty trash");
    }
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

    // `LastEditedByAdminAt` isn't in the lifecycle's tracked diff fields (it's deliberately
    // excluded so real admin edits don't get re-stamped by this override), so afterUpdate
    // never sees this write as a change and stays silent. Log it explicitly here instead —
    // otherwise a curator backdating the "last edited" column to reorder the admin list
    // leaves no trace that the value is a manual override rather than a genuine edit.
    const existing = await strapi.entityService.findOne("api::product.product", productId, {
      fields: ["LastEditedByAdminAt"],
    });
    if (!existing) {
      return ctx.notFound("Product not found");
    }

    const product = await strapi.entityService.update("api::product.product", productId, {
      data: { LastEditedByAdminAt: normalizedDisplayAt },
    });

    const userId = Number((ctx.state as any)?.user?.id);
    if (Number.isSafeInteger(userId) && userId > 0) {
      await recordAdminAudit(strapi, {
        resourceType: "Product",
        resourceId: productId,
        action: "Update",
        title: "تاریخ نمایش محصول به صورت دستی تنظیم شد",
        message: `تاریخ «آخرین ویرایش» محصول #${productId} برای چینش دستی فهرست تغییر کرد`,
        messageEn: `Product #${productId} display date manually overridden for listing order`,
        severity: "warning",
        actor: { id: userId },
        changes: {
          LastEditedByAdminAt: {
            from: (existing as any).LastEditedByAdminAt ?? null,
            to: normalizedDisplayAt,
          },
        },
        metadata: { productId, displayAt: normalizedDisplayAt },
      });
    }

    ctx.body = {
      data: {
        id: product.id,
        LastEditedByAdminAt: normalizedDisplayAt,
      },
    };
  },

  /**
   * Stashes an admin's in-progress (unsaved) edit as an ephemeral overlay and
   * returns a bearer token for it. Never touches the live product row — see
   * services/product-preview-draft.ts.
   */
  async createPreviewDraft(ctx) {
    const productId = Number(ctx.params?.id);
    if (!Number.isSafeInteger(productId) || productId <= 0) {
      ctx.status = 400;
      ctx.body = {
        error: { code: "INVALID_PRODUCT_ID", message: "A valid product ID is required" },
      };
      return;
    }

    const overlay = sanitizeProductPreviewOverlay(ctx.request?.body?.data);
    const userId = Number(ctx.state?.user?.id);

    const token = await createProductPreviewDraft(
      productId,
      overlay,
      Number.isSafeInteger(userId) && userId > 0 ? userId : undefined,
    );

    // The admin app and storefront are separate origins (admin.infinitycolor.co
    // vs. infinitycolor.co, per config/middlewares.ts) with no rewrite between
    // them, so the admin can't build this link itself from window.location.
    const frontendOrigin = (
      process.env.FRONTEND_BASE_URL ||
      process.env.FRONTEND_URL ||
      "https://infinitycolor.co"
    ).replace(/\/$/, "");

    ctx.body = { data: { token, url: `${frontendOrigin}/pdp/preview/${token}` } };
  },

  /**
   * Public by design — the token itself is the credential, the same bearer
   * pattern used for OTP/credential challenges elsewhere in this backend.
   * Always renders as if viewed by an admin (bypasses the Active-only gate),
   * since a preview link only ever exists because an admin created it.
   */
  async resolvePreviewDraft(ctx) {
    const token = String(ctx.params?.token || "");
    const draft = await readProductPreviewDraft(token);
    if (!draft) {
      return ctx.notFound("Preview expired or not found");
    }

    const product = await loadProductById(strapi, draft.productId, true, PRODUCT_POPULATE);
    if (!product) {
      return ctx.notFound("Product not found");
    }

    await applyPreviewOverlay(strapi, product, draft.overlay);

    ctx.set("Cache-Control", "no-store");
    ctx.body = { data: product };
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
      if ((action === "schedule" || action === "retry") && result.scheduledPublishAt)
        queueState = "pending-reconciliation";
      await afterCatalogCommit(strapi, async () => {
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
          try {
            await removeScheduledProductPublication(productId, result.previousScheduleRevision);
          } catch {
            queueState = "pending-reconciliation";
          }
        }

        if (result.needsPublicationEffects) {
          try {
            await runPublicationEffects(strapi, productId, result.publicationRevision);
          } catch {
            queueState = "pending-reconciliation";
          }
        }
        if (ctx.body?.data?.id === result.productId) ctx.body.data.queueState = queueState;
      });

      ctx.body = {
        data: {
          id: result.productId,
          Status: result.status,
          scheduledPublishAt: result.scheduledPublishAt,
          scheduledPublishTimezone: result.scheduledPublishTimezone,
          scheduledPublishRevision: result.scheduleRevision,
          publicationRevision: result.publicationRevision,
          publishedVariationCount: result.publishedVariationCount || 0,
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

  async replaceVariationColor(ctx) {
    const body = ctx.request?.body?.data ?? ctx.request?.body ?? {};
    const actor = await resolveAdminActor(strapi, ctx.state?.user);
    try {
      const result = await replaceProductVariationColor(strapi, {
        productId: ctx.params?.id,
        fromColorId: body.fromColorId,
        toColorId: body.toColorId,
        newColor: body.newColor,
        removeEmptyDrafts: body.removeEmptyDrafts === true,
        dryRun: body.dryRun === true,
        canDeleteVariations: Boolean(
          actor && hasCapability(actor.role, "product.variation.delete"),
        ),
      });
      ctx.body = { data: result };
    } catch (error) {
      if (!(error instanceof ColorReplaceError)) throw error;
      const details = { data: { errorCode: error.errorCode, ...error.data } };
      if (error.status === 403) return ctx.forbidden(error.message, details);
      if (error.status === 404) return ctx.notFound(error.message, details);
      if (error.status === 409) return ctx.conflict(error.message, details);
      return ctx.badRequest(error.message, details);
    }
  },

  /**
   * Apply public-only filters for non-admin users
   * Ensures drafts/removed products are hidden from non-admins
   */
  applyPublicProductFilters(ctx) {
    const user = ctx.state.user;
    const isAdmin = isAdminUser(user);
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

    if (isAdmin) {
      // Staff read drafts, scheduled and trashed products through the core
      // routes, but a permanently deleted product is a tombstone that no
      // catalog surface may return.
      andConditions.push({ purgedAt: { $null: true } });
      ctx.query = { ...ctx.query, filters: { $and: andConditions } };
      return false;
    }

    // Exact identity reads (e.g. secondary card photos) are not discovery.
    const exactId = existingFilters?.id?.$eq;
    const isIdentityLookup =
      (typeof exactId === "number" || typeof exactId === "string") &&
      /^\d+$/.test(String(exactId)) && Number.isSafeInteger(Number(exactId)) && Number(exactId) > 0;

    // A fully trusted migration request must see an existing inactive product
    // by external_id so the idempotent importer updates it instead of trying a
    // duplicate create. Trashed products remain excluded.
    andConditions.push(
      isTrustedWordPressMigrationRequest()
        ? { removedAt: { $null: true } }
        : String(ctx.query?.view || "") === "card" || isIdentityLookup
          ? publicProductFilters()
          : publicProductDiscoveryFilters(ctx.query?.oppsi === "true" || ctx.query?.oppsi === "1"),
    );

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
        isAdmin: isAdminUser(ctx.state.user),
        oppsi: restQuery.oppsi,
        filters: restQuery.filters,
        sort: restQuery.sort,
        availability: restQuery.availability,
        price: restQuery.price,
        hasDiscount: restQuery.hasDiscount,
        excludeDiscount: restQuery.excludeDiscount,
        curated: restQuery.curated,
        offer: restQuery.offer,
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
      // findOne ignores `filters`, so the tombstone rule is enforced on the result.
      if (isProductPurged(response?.data)) return ctx.notFound("Product not found");
      return response;
    }

    const product = response?.data;
    if (!isProductPubliclyVisible(product)) {
      return ctx.notFound("Product not found");
    }

    const isAdmin = isAdminUser(user);
    if (!isAdmin && product?.id) {
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
      const isPublic = isProductPubliclyVisible(productData);
      if (!isAdmin && !isPublic) {
        return ctx.notFound("Product not found");
      }

      strapi.log.info(
        `[Product.findBySlug] Successfully found product: ${productData.id} (${productData.Title || "N/A"})`,
      );

      if (!isAdmin && isPublic && productData?.id) {
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
