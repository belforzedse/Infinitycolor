"use strict";

/**
 * Pure transform functions: WooCommerce entities → Strapi payloads.
 *
 * Everything here is side-effect free and dependency-light so it can be unit-tested
 * exhaustively with fixtures. This is where the data-mapping bug fixes live:
 *  - prices: 0 is NOT treated as "missing"; only-sale-price products keep a price;
 *    a brand-new variation with no price is flagged, not silently set to 0.
 *  - SKU is stable (no per-run mutation).
 *  - Weight / ProductType / IsSimpleProduct are actually written.
 *  - Stock is derived from stock_status when stock isn't managed.
 */

const { resolveSlug } = require("./slug");
const { resolveColorMapping, DEFAULT_COLOR } = require("../../utils/colorMappings");
const { wooSourceTimestamps } = require("../../utils/sourceTimestamps");

const EXTERNAL_SOURCE = "woocommerce";

/** Parse a WooCommerce numeric string. Returns NaN for blank/invalid. */
function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return NaN;
  }
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : NaN;
}

/** Convert a price using the configured multiplier and round to an integer. */
function convertPrice(value, multiplier = 1) {
  const n = toNumber(value);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return Math.round(n * (Number.isFinite(multiplier) ? multiplier : 1));
}

/**
 * Normalize a product/title string: trim, collapse whitespace, insert a space at
 * letter↔digit boundaries (e.g. "bearB00130" → "bear B00130"). Matches legacy
 * behaviour so existing titles don't churn.
 */
function normalizeName(name) {
  if (!name || typeof name !== "string") {
    return "";
  }
  return name
    .trim()
    .replace(/\s+/g, " ")
    .replace(/([a-zA-Z؀-ۿ])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z؀-ۿ])/g, "$1 $2")
    .trim();
}

/** Light richtext cleanup (Strapi richtext accepts HTML; just normalize whitespace). */
function prepareRichtext(html) {
  if (!html || typeof html !== "string") {
    return "";
  }
  return html
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

/**
 * Map WooCommerce product status → Strapi Status enum (Active | InActive).
 * Unknown statuses default to InActive (safer: never auto-publish a draft).
 */
function mapProductStatus(wcStatus, statusMappings = {}) {
  const mapped = statusMappings[wcStatus];
  return mapped || "InActive";
}

/**
 * Map a WooCommerce product to a Strapi product payload (excluding media, which is
 * attached separately so a failed re-download never nulls existing images).
 *
 * @param {object} wcProduct
 * @param {object} [opts]
 * @param {(wooCategoryId:number)=>(number|null)} [opts.resolveCategoryId]
 * @param {(wooCategoryId:number)=>(number|null)} [opts.resolveCategoryParent] - returns WC parent id
 * @param {Record<string,string>} [opts.statusMappings]
 * @returns {{ data: object, mainCategoryMissing: boolean, otherCategoryMisses: number[] }}
 */
function mapProduct(wcProduct, opts = {}) {
  const { resolveCategoryId = () => null, resolveCategoryParent = () => null, statusMappings = {} } = opts;

  const data = {
    Title: normalizeName(wcProduct.name),
    Slug: resolveSlug(wcProduct, "product"),
    Description: prepareRichtext(wcProduct.description || wcProduct.short_description || ""),
    Status: mapProductStatus(wcProduct.status, statusMappings),
    ProductType: wcProduct.type === "simple" ? "Simple" : "Variable",
    IsSimpleProduct: wcProduct.type === "simple",
    AverageRating: toNumber(wcProduct.average_rating) || null,
    RatingCount: Number.parseInt(wcProduct.rating_count, 10) || 0,
    external_id: wcProduct.id.toString(),
    external_source: EXTERNAL_SOURCE,
  };
  const sourceTimestamps = wooSourceTimestamps(wcProduct);
  if (sourceTimestamps) {
    // This destination field powers the "last manual change" ordering. For
    // migrated products WooCommerce is the historical editor of record.
    data.LastEditedByAdminAt = sourceTimestamps.updatedAt;
  }

  // Weight is an integer in Strapi (default 100). Only override when WooCommerce
  // actually provides a numeric weight, otherwise leave the schema default intact.
  const weight = toNumber(wcProduct.weight);
  if (Number.isFinite(weight) && weight > 0) {
    data.Weight = Math.round(weight);
  }

  // Categories → Strapi relation ids
  // When a product has both a parent and a child category, the child (leaf) becomes
  // product_main_category and the parent goes to product_other_categories.
  const categories = Array.isArray(wcProduct.categories) ? wcProduct.categories : [];
  let mainCategoryMissing = false;
  const otherCategoryMisses = [];

  if (categories.length > 0) {
    // Identify which category IDs in this product's list are referenced as parents
    // by another category also in the list. A "leaf" is one that no sibling points to.
    const wcCategoryIds = new Set(categories.map(c => c.id));
    const parentIdsInList = new Set(
      categories
        .map(cat => resolveCategoryParent(cat.id))
        .filter(pid => pid != null && wcCategoryIds.has(pid)),
    );
    const leafCats = categories.filter(cat => !parentIdsInList.has(cat.id));
    // Use the leaf (child) as main when the hierarchy is unambiguous; else fall back to first.
    const mainCat = leafCats.length > 0 && leafCats.length < categories.length
      ? leafCats[0]
      : categories[0];

    const mainId = resolveCategoryId(mainCat.id);
    if (mainId) {
      data.product_main_category = mainId;
    } else {
      mainCategoryMissing = true;
    }

    const otherIds = [];
    for (const cat of categories) {
      if (cat.id === mainCat.id) continue;
      const sid = resolveCategoryId(cat.id);
      if (sid) {
        otherIds.push(sid);
      } else {
        otherCategoryMisses.push(cat.id);
      }
    }
    data.product_other_categories = otherIds;
  }

  return {
    data,
    mainCategoryMissing,
    otherCategoryMisses,
    sizeGuideMatrix: extractSizeGuideMatrix(wcProduct),
    sourceTimestamps,
  };
}

/**
 * Extract and sanitize the product size-guide matrix stored in WooCommerce meta.
 * Legacy importer supported both meta keys; keep the same source compatibility.
 *
 * @param {object} wcProduct
 * @returns {string[][] | null}
 */
function extractSizeGuideMatrix(wcProduct) {
  if (!wcProduct || !Array.isArray(wcProduct.meta_data)) {
    return null;
  }

  const sizeGuideKeys = ["product_size_guide", "product-custom-meta-inp"];
  const metaEntry = wcProduct.meta_data.find((meta) => meta && sizeGuideKeys.includes(meta.key));

  if (!metaEntry || metaEntry.value === undefined || metaEntry.value === null) {
    return null;
  }

  let rawValue = metaEntry.value;
  if (typeof rawValue === "string") {
    rawValue = rawValue.trim();
    if (rawValue === "") {
      return null;
    }
    try {
      rawValue = JSON.parse(rawValue);
    } catch {
      return null;
    }
  }

  if (!Array.isArray(rawValue)) {
    return null;
  }

  const sanitized = rawValue
    .filter((row) => Array.isArray(row))
    .map((row) =>
      row.map((cell) => {
        if (cell === null || cell === undefined) {
          return "";
        }
        return typeof cell === "string" ? cell : String(cell);
      }),
    );

  const hasContent = sanitized.some((row) =>
    row.some((cell) => typeof cell === "string" && cell.trim() !== ""),
  );

  return hasContent ? sanitized : null;
}

/**
 * Map a WooCommerce category to a Strapi category payload.
 * @param {object} wcCategory
 * @param {(wooParentId:number)=>(number|null)} [resolveParentId]
 */
function mapCategory(wcCategory, resolveParentId = () => null) {
  const data = {
    Title: wcCategory.name,
    Slug: resolveSlug(wcCategory, "category"),
    external_id: wcCategory.id.toString(),
    external_source: EXTERNAL_SOURCE,
  };

  let parentMissing = false;
  if (wcCategory.parent && wcCategory.parent !== 0) {
    const parentId = resolveParentId(wcCategory.parent);
    if (parentId) {
      data.parent = parentId;
    } else {
      parentMissing = true; // import as root for now; a later pass links it
    }
  }

  return { data, parentMissing };
}

/** Stable SKU for a variation. Never mutated on re-sync. */
function generateVariationSku(wcVariation, parentWooId) {
  if (wcVariation.sku && wcVariation.sku.toString().trim() !== "") {
    return wcVariation.sku.toString().trim();
  }
  const pid = wcVariation.parent_id || parentWooId || wcVariation._parentProduct?.id;
  return `WC-${pid}-${wcVariation.id}`;
}

/**
 * Compute Price / DiscountPrice for a variation, with parent-product fallback.
 *
 * Returns `{ price, discountPrice? }` or `{ priceMissing: true }` when WooCommerce
 * has no usable price anywhere. A `0` regular price with a positive sale price is
 * treated as "only sale price" → the sale price becomes Price (not a free product).
 *
 * @param {object} wcVariation
 * @param {object} [parentProduct]
 * @param {number} [multiplier=1]
 */
function computeVariationPricing(wcVariation, parentProduct = {}, multiplier = 1) {
  const pos = (n) => Number.isFinite(n) && n > 0;

  const varRegular = toNumber(wcVariation.regular_price ?? wcVariation.price);
  const varSale = toNumber(wcVariation.sale_price);
  const parentRegular = toNumber(parentProduct.regular_price ?? parentProduct.price);
  const parentSale = toNumber(parentProduct.sale_price);

  // Resolve regular and sale independently (variation level first, then parent),
  // so a variation that has *only* a sale price still gets a price.
  const regular = pos(varRegular) ? varRegular : pos(parentRegular) ? parentRegular : NaN;
  const sale = pos(varSale) ? varSale : pos(parentSale) ? parentSale : NaN;
  const onSale = wcVariation.on_sale;

  const regularValid = pos(regular);
  const saleValid = pos(sale);

  if (regularValid && saleValid && sale < regular && onSale !== false) {
    return {
      price: convertPrice(regular, multiplier),
      discountPrice: convertPrice(sale, multiplier),
    };
  }
  if (regularValid) {
    return { price: convertPrice(regular, multiplier) };
  }
  if (saleValid) {
    // Only a sale price exists anywhere — use it as the price rather than dropping it.
    return { price: convertPrice(sale, multiplier) };
  }
  return { priceMissing: true };
}

/**
 * Map a WooCommerce variation to a Strapi variation payload.
 *
 * @param {object} wcVariation
 * @param {object} opts
 * @param {number} opts.parentStrapiId
 * @param {object} [opts.parentProduct]
 * @param {number} [opts.multiplier=1]
 * @param {boolean} [opts.preserveMissingPrice=false] when updating, omit Price if WC price is blank
 * @returns {{ data: object, priceMissing: boolean }}
 */
function mapVariation(wcVariation, opts) {
  const { parentStrapiId, parentProduct = {}, multiplier = 1, preserveMissingPrice = false } = opts;

  if (!parentStrapiId || typeof parentStrapiId !== "number") {
    throw new Error(`Variation ${wcVariation.id}: invalid parent Strapi id: ${parentStrapiId}`);
  }

  const sku = generateVariationSku(wcVariation, parentProduct.id);
  const status = (wcVariation.status || "").toLowerCase();

  const data = {
    SKU: sku,
    // Default to published when WooCommerce omits a status, so imported variations
    // are actually visible (the legacy importer needed a publish-all band-aid).
    IsPublished: status ? status === "publish" : true,
    product: parentStrapiId,
    external_id: wcVariation.id.toString(),
    external_source: EXTERNAL_SOURCE,
  };

  const pricing = computeVariationPricing(wcVariation, parentProduct, multiplier);
  let priceMissing = false;
  if (pricing.priceMissing) {
    priceMissing = true;
    // Only set Price (to 0) when NOT preserving — but the engine flags create-with-missing-price
    // as a failure instead of writing a 0-price product. On update we omit Price entirely.
    if (!preserveMissingPrice) {
      data.Price = 0;
    }
  } else {
    data.Price = pricing.price;
    if (pricing.discountPrice !== undefined) {
      data.DiscountPrice = pricing.discountPrice;
    } else if (preserveMissingPrice) {
      // Existing rows must have a stale sale price cleared when Woo ends a sale.
      data.DiscountPrice = null;
    }
  }

  return { data, priceMissing, sourceTimestamps: wooSourceTimestamps(wcVariation) };
}

/** Identify a WooCommerce attribute name as color | size | model. */
function identifyAttributeType(attributeName) {
  const name = (attributeName || "").toLowerCase();
  if (name.includes("رنگ") || name.includes("color") || name.includes("colour")) {
    return "color";
  }
  if (name.includes("سایز") || name.includes("اندازه") || name.includes("size")) {
    return "size";
  }
  return "model";
}

/**
 * Resolve an attribute value to a Strapi-ready descriptor. Colors are normalized
 * through the shared color-mapping table (Persian name → Title + hex ColorCode).
 *
 * IMPORTANT: when a color value is NOT in the mapping table, the ORIGINAL value is
 * preserved as the Title with NO colorCode. Stores often enter distinct color
 * variants by code on the رنگ attribute (e.g. "کد ۱", "کد ۲", …); collapsing
 * every unmapped value to a white swatch would merge distinct variants visually.
 * Hex-less colors render as text/model-style selectors on the PDP instead.
 *
 * @param {"color"|"size"|"model"} type
 * @param {string} value
 * @returns {{ title: string, colorCode?: string, matched: boolean, externalId: string } | null}
 */
function resolveAttribute(type, value) {
  if (!value || value.toString().trim() === "") {
    return null;
  }
  const raw = value.toString().trim();

  if (type === "color") {
    const mapping = resolveColorMapping(raw);
    const title = mapping.matched ? mapping.title : raw;
    // Only carry a colorCode when the mapping table provides a genuine hex value.
    // Unmapped colors (e.g. "کد ۱") get no colorCode — never default to white.
    const colorCode = mapping.matched && mapping.colorCode ? mapping.colorCode : undefined;
    return {
      title,
      ...(colorCode !== undefined && { colorCode }),
      matched: Boolean(mapping.matched),
      externalId: `color_${title.toLowerCase().replace(/\s+/g, "_")}`,
    };
  }

  return {
    title: raw,
    matched: true,
    externalId: `${type}_${raw.toLowerCase().replace(/\s+/g, "_")}`,
  };
}

/**
 * Determine the stock Count to write for a variation/simple product.
 *
 * Gate-1 migration policy accepts managed stock only. Unmanaged units must cause
 * their whole parent product to be skipped before this mapper is called; throwing
 * here is a fail-closed backstop against accidental synthetic inventory.
 *
 * @param {object} wcEntity variation or simple product
 * @returns {{ count: number, externalId: string }}
 */
function mapStock(wcEntity) {
  const externalId = `stock_${wcEntity.id}`;

  const managed = wcEntity.manage_stock === true;
  const qty = wcEntity.stock_quantity;

  if (!managed) {
    const error = new Error(`Unmanaged stock is not eligible for migration: ${wcEntity.id}`);
    error.code = "UNMANAGED_STOCK_REJECTED";
    throw error;
  }

  const numericQuantity = Number(qty);
  const count = Number.isFinite(numericQuantity) ? Math.max(0, numericQuantity) : 0;
  return { count, externalId };
}

/**
 * A product is eligible only when every sellable unit has explicit managed
 * stock. Simple products are one sellable unit; variable parents are evaluated
 * against the complete live variation collection.
 */
function evaluateProductStockEligibility(wcProduct, wcVariations = []) {
  const isSimple =
    wcProduct?.type === "simple" ||
    !Array.isArray(wcProduct?.variations) ||
    wcProduct.variations.length === 0;

  if (isSimple) {
    return wcProduct?.manage_stock === true
      ? { eligible: true, reason: null, unmanagedVariationIds: [] }
      : { eligible: false, reason: "simple-unmanaged-stock", unmanagedVariationIds: [] };
  }

  if (!Array.isArray(wcVariations) || wcVariations.length === 0) {
    return { eligible: false, reason: "variable-without-live-variations", unmanagedVariationIds: [] };
  }

  const unmanagedVariationIds = wcVariations
    .filter((variation) => variation?.manage_stock !== true)
    .map((variation) => Number(variation.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);

  return unmanagedVariationIds.length === 0
    ? { eligible: true, reason: null, unmanagedVariationIds: [] }
    : { eligible: false, reason: "variation-unmanaged-stock", unmanagedVariationIds };
}

/**
 * Build a synthetic "variation" for a WooCommerce simple product so it has a
 * purchasable Strapi product-variation (Price/SKU/stock). Simple products have no
 * WooCommerce variations of their own.
 *
 * @param {object} wcProduct
 * @returns {object} a variation-shaped object consumable by mapVariation/mapStock
 */
function synthesizeSimpleVariation(wcProduct) {
  return {
    id: wcProduct.id,
    parent_id: wcProduct.id,
    sku: wcProduct.sku || `WC-${wcProduct.id}`,
    regular_price: wcProduct.regular_price,
    price: wcProduct.price,
    sale_price: wcProduct.sale_price,
    on_sale: wcProduct.on_sale,
    status: wcProduct.status,
    manage_stock: wcProduct.manage_stock,
    stock_quantity: wcProduct.stock_quantity,
    stock_status: wcProduct.stock_status,
    attributes: [],
    date_created: wcProduct.date_created,
    date_created_gmt: wcProduct.date_created_gmt,
    date_modified: wcProduct.date_modified,
    date_modified_gmt: wcProduct.date_modified_gmt,
    _synthetic: true,
    _parentProduct: wcProduct,
  };
}

module.exports = {
  EXTERNAL_SOURCE,
  toNumber,
  convertPrice,
  normalizeName,
  prepareRichtext,
  mapProductStatus,
  mapProduct,
  extractSizeGuideMatrix,
  mapCategory,
  generateVariationSku,
  computeVariationPricing,
  mapVariation,
  identifyAttributeType,
  resolveAttribute,
  mapStock,
  evaluateProductStockEligibility,
  synthesizeSimpleVariation,
};
