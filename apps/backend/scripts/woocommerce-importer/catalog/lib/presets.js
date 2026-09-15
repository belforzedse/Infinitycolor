"use strict";

/**
 * Pure preset / scope resolution for the catalog importer.
 *
 * A "scope" controls which phases run and how variations are written. The TUI and
 * CLI map a user-facing preset to a scope + run options. Kept pure so every preset
 * is unit-tested (no surprise side effects when someone picks "Stock Sync").
 *
 * WooCommerce is always the read-only source of truth; no scope ever writes to WC.
 */

const SCOPES = [
  "full",
  "full-sync",
  "no-media",
  "product-no-media",
  "categories",
  "category-editorial",
  "stock",
  "price",
  "media",
  "content-refresh",
  "inventory-instock",
];

/**
 * Resolve a scope to concrete phase flags.
 *
 * `mediaPolicy` is only present on scopes that need special media handling. When
 * absent (every legacy scope) the engine treats it as "always" — i.e. the media
 * phase re-attaches CoverImage/Media as before. "preserve" means: import & attach
 * media only for products that don't already have both a cover and a gallery.
 *
 * `stockGate` is likewise only present where it applies. "instock-or-verify"
 * lets the engine skip the (expensive) variation fetch for a product Woo
 * reports out of stock *when Strapi already holds zero for every one of its
 * sellable units* — it never writes a value it did not read from Woo. See
 * CatalogEngine#syncOneProduct.
 *
 * `skipStock` is the stock-side twin of `skipMedia`: it forces `stock:false` on
 * every scope that would otherwise write inventory, so a catalog refresh can
 * update names/prices/media/categories while leaving product-stocks untouched.
 * It also drops `stockGate`, which only exists to skip work on behalf of the
 * stock phase and would otherwise cost price updates on out-of-stock products.
 *
 * `variationFields` selects what a variation write covers: "all" writes the whole
 * record, "price-only" touches nothing but Price/DiscountPrice, and "no-price" is
 * its complement — the relation/attribute half of "all" with Price/DiscountPrice
 * left alone on rows that already exist. The stripping is conditioned on the row
 * existing because a row being created has no stored price to preserve and cannot
 * be written without one; `content-refresh` pairs "no-price" with `onlyExisting`,
 * so in practice that scope creates no variations at all.
 *
 * @param {string} scope
 * @param {{ skipMedia?: boolean, skipStock?: boolean }} [opts]
 * @returns {{ categories:boolean, categoryEditorial:boolean, products:boolean, variations:boolean, stock:boolean,
 *   media:boolean, onlyExisting:boolean, variationFields:"all"|"price-only"|"no-price"|"none",
 *   mediaPolicy?:"always"|"preserve" }}
 */
function resolveScope(scope, opts = {}) {
  const skipMedia = Boolean(opts.skipMedia);
  const skipStock = Boolean(opts.skipStock);
  // A stock-only scope with stock suppressed would run the whole product loop
  // and write nothing. Fail loudly rather than burn a production pass.
  if (skipStock && scope === "stock") {
    throw new Error('Scope "stock" writes nothing with skipStock; pick another scope or drop skipStock.');
  }
  switch (scope) {
    case "full":
      return f({ categories: true, categoryEditorial: true, products: true, variations: true, stock: !skipStock, media: !skipMedia, variationFields: "all" });
    case "full-sync":
      return f({
        categories: true, categoryEditorial: true, products: true, variations: true, stock: !skipStock,
        media: !skipMedia, variationFields: "all", mediaPolicy: "preserve",
      });
    case "no-media":
      return f({ categories: true, products: true, variations: true, stock: !skipStock, media: false, variationFields: "all" });
    case "product-no-media":
      return f({ categories: false, products: true, variations: true, stock: !skipStock, media: false, variationFields: "all" });
    case "categories":
      return f({ categories: true, categoryEditorial: true });
    case "category-editorial":
      return f({ categoryEditorial: true });
    case "stock":
      return f({ stock: true, onlyExisting: true });
    case "price":
      return f({ variations: true, onlyExisting: true, variationFields: "price-only" });
    case "media":
      return f({ media: true, onlyExisting: true });
    // Everything a product's *content* is made of — description, category
    // relations, variation relations/attributes, gallery, category editorial —
    // and nothing that is a number a customer transacts on. Prices and stock
    // are the two fields the shop edits outside WooCommerce, so a content
    // refresh that rewrote them would undo that work; `onlyExisting` keeps the
    // run to products already imported, since creating one here would leave a
    // visible product with no stock row.
    case "content-refresh":
      return f({
        categories: true,
        categoryEditorial: true,
        products: true,
        variations: true,
        media: !skipMedia,
        onlyExisting: true,
        variationFields: "no-price",
      });
    // One pass doing what "stock" and "price" each did with a separate full
    // variation fetch: `variations` + `stock` both write off a single fetch,
    // and `stockGate` skips the fetch entirely for out-of-stock products that
    // Strapi already records as empty. Keep variationFields "price-only" —
    // "all" would make resolveProductConcurrency force serial processing.
    case "inventory-instock":
      return f({
        variations: true,
        stock: !skipStock,
        onlyExisting: true,
        variationFields: "price-only",
        // The gate skips the variation fetch for out-of-stock products, which is
        // only sound while stock is what we came to write. With stock off it
        // would silently drop those products' price updates.
        ...(skipStock ? {} : { stockGate: "instock-or-verify" }),
      });
    default:
      throw new Error(`Unknown scope: ${scope}. Use one of: ${SCOPES.join(", ")}`);
  }
}

/** Fill defaults for a flags object. */
function f(partial) {
  return {
    categories: false,
    categoryEditorial: false,
    products: false,
    variations: false,
    stock: false,
    media: false,
    onlyExisting: false,
    variationFields: "none",
    ...partial,
  };
}

/**
 * True when a variation write carries the attribute/relation half of the record,
 * which is what makes the run need the attribute caches and the Woo global
 * attribute registry, and what forces serial product processing (those caches
 * are find-or-create). Both "all" and "no-price" do; "price-only" does not.
 */
function writesVariationAttributes(flags) {
  return Boolean(flags.variations)
    && (flags.variationFields === "all" || flags.variationFields === "no-price");
}

/** True when the product loop needs to run at all for these flags. */
function needsProductLoop(flags) {
  return flags.products || flags.variations || flags.stock || flags.media;
}

/**
 * The user-facing preset catalogue (rendered by the TUI). Each entry maps to
 * `runSync`/`runVerify` options. `confirm: true` means a live (non-dry) run must be
 * typed-confirmed.
 */
const PRESETS = [
  { id: "full", label: "Full Sync", description: "Categories + products + variations + stock + media", run: { scope: "full" }, confirm: true },
  { id: "full-sync", label: "Full Sync — Safe Media", description: "Full sync; imports media only for products missing a cover or gallery", run: { scope: "full-sync" }, confirm: true },
  { id: "no-media", label: "Full Sync — No Media", description: "Everything except image/video upload (fast)", run: { scope: "no-media" }, confirm: true },
  { id: "dry-run", label: "Catalog Dry-Run", description: "Preview a full sync — no writes", run: { scope: "full", dryRun: true }, confirm: false },
  { id: "stock", label: "Stock Sync", description: "Refresh stock Count for existing variations only", run: { scope: "stock" }, confirm: true },
  { id: "price", label: "Price Sync", description: "Update Price/DiscountPrice on existing variations only", run: { scope: "price" }, confirm: true },
  {
    id: "inventory-instock",
    label: "Inventory Sync — In-Stock",
    description: "Stock + price in one pass; skips out-of-stock products already empty in Strapi",
    run: { scope: "inventory-instock" },
    confirm: true,
  },
  { id: "media", label: "Media Sync", description: "Upload & attach missing media for existing products only", run: { scope: "media" }, confirm: true },
  {
    id: "content-refresh",
    label: "Content Refresh",
    description: "Descriptions, variation relations, gallery & category editorial — never price or stock",
    run: { scope: "content-refresh" },
    confirm: true,
  },
  { id: "categories", label: "Categories Only", description: "Sync categories only", run: { scope: "categories" }, confirm: true },
  { id: "category-editorial", label: "Category Editorial", description: "Create missing category SEO content and localize audio", run: { scope: "category-editorial" }, confirm: true },
  { id: "verify", label: "Verify", description: "Compare WooCommerce ↔ Strapi by external_id (read-only)", verify: true, confirm: false },
];

/**
 * Resolve a preset id to its run descriptor.
 * @param {string} id
 * @returns {{ id:string, label:string, verify?:boolean, run?:object, confirm:boolean }}
 */
function resolvePreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) {
    throw new Error(`Unknown preset: ${id}`);
  }
  return preset;
}

module.exports = {
  SCOPES,
  PRESETS,
  resolveScope,
  resolvePreset,
  needsProductLoop,
  writesVariationAttributes,
};
