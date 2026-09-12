"use strict";

const crypto = require("crypto");
const { resolveColorMapping } = require("../../utils/colorMappings");

const EXTERNAL_SOURCE = "woocommerce";

function canonicalKey(value) {
  let decoded = String(value ?? "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Invalid percent escapes are kept verbatim and will fail exact matching.
  }
  return decoded
    .normalize("NFKC")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("fa-IR");
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function normalizeTaxonomySlug(value) {
  const slug = canonicalKey(value).replace(/^pa_/, "pa_");
  return slug.startsWith("pa_") ? slug : `pa_${slug.replace(/^pa-/, "")}`;
}

function legacyProjection(slug, scope) {
  if (scope !== "Global") return "None";
  const normalized = normalizeTaxonomySlug(slug);
  if (normalized === "pa_color") return "Color";
  if (normalized === "pa_size") return "Size";
  return "None";
}

function attributeType(slug, title) {
  const normalizedSlug = normalizeTaxonomySlug(slug);
  const normalizedTitle = canonicalKey(title);
  if (
    normalizedSlug === "pa_color" ||
    normalizedSlug === "pa_رنگ" ||
    normalizedTitle === "رنگ"
  ) {
    return "Color";
  }
  return "Text";
}

function colorCodeFor(type, title) {
  if (type !== "Color") return undefined;
  const mapped = resolveColorMapping(String(title || ""));
  return mapped.matched && /^#[0-9a-f]{6}$/i.test(mapped.colorCode || "")
    ? mapped.colorCode
    : undefined;
}

function makeTerm({ externalId, sourceKey, sourceAliases = [], title, slug, position, type }) {
  return {
    externalId,
    sourceKey,
    sourceAliases: Array.from(new Set([sourceKey, ...sourceAliases].filter(Boolean))),
    title: String(title || "").trim(),
    slug: String(slug || "").trim(),
    position: Number(position || 0),
    colorCode: colorCodeFor(type, title),
  };
}

/**
 * Build the definitions, allowed values, and assignments for one Woo product.
 * Global taxonomy definitions remain reusable; id=0 attributes are namespaced to
 * their owner product so a custom "سایز" never aliases global pa_size.
 */
function buildProductAttributePlan(wcProduct, globalRegistry = new Map()) {
  const dimensions = [];
  const sourceProductId = Number(wcProduct?.id);
  const attributes = Array.isArray(wcProduct?.attributes) ? wcProduct.attributes : [];

  attributes.forEach((sourceAttribute, sourcePosition) => {
    const globalId = Number(sourceAttribute?.id || 0);
    const registryEntry = globalId > 0 ? globalRegistry.get(globalId) : null;
    const scope = globalId > 0 ? "Global" : "Product";
    const sourceName = String(sourceAttribute?.name || registryEntry?.name || "").trim();
    if (!sourceName) return;

    const sourceKey =
      scope === "Global" ? `global:${globalId}` : `product:${sourceProductId}:${canonicalKey(sourceName)}`;
    const slug =
      scope === "Global"
        ? normalizeTaxonomySlug(registryEntry?.slug || sourceName)
        : `product-${sourceProductId}-${shortHash(canonicalKey(sourceName))}`;
    const type = attributeType(slug, sourceName);
    const projection = legacyProjection(slug, scope);
    const definitionExternalId =
      scope === "Global" ? `attribute:${globalId}` : `attribute:${sourceKey}`;
    const registryTermsByName = registryEntry?.termsByName || new Map();
    const seenTerms = new Set();
    const terms = [];

    (Array.isArray(sourceAttribute?.options) ? sourceAttribute.options : []).forEach(
      (option, optionPosition) => {
        const title = String(option ?? "").trim();
        const optionKey = canonicalKey(title);
        if (!title || seenTerms.has(optionKey)) return;
        seenTerms.add(optionKey);
        const globalTerm = registryTermsByName.get(optionKey);
        const termExternalId =
          scope === "Global" && globalTerm?.id
            ? `term:${globalTerm.id}`
            : `term:${sourceKey}:${shortHash(optionKey)}`;
        terms.push(
          makeTerm({
            externalId: termExternalId,
            sourceKey: optionKey,
            title,
            slug: globalTerm?.slug || optionKey.replace(/\s+/g, "-"),
            sourceAliases: globalTerm?.slug ? [canonicalKey(globalTerm.slug)] : [],
            position: globalTerm?.menu_order ?? optionPosition,
            type,
          }),
        );
      },
    );

    const termsBySourceKey = new Map();
    const ambiguousTermKeys = new Set();
    for (const term of terms) {
      for (const alias of term.sourceAliases) {
        if (termsBySourceKey.has(alias) && termsBySourceKey.get(alias) !== term) {
          ambiguousTermKeys.add(alias);
          termsBySourceKey.delete(alias);
        } else if (!ambiguousTermKeys.has(alias)) {
          termsBySourceKey.set(alias, term);
        }
      }
    }

    dimensions.push({
      sourceKey,
      sourceId: globalId,
      title: sourceName,
      slug,
      scope,
      type,
      legacyProjection: projection,
      position: Number(sourceAttribute?.position ?? sourcePosition ?? 0),
      isVisible: sourceAttribute?.visible !== false,
      isVariation: sourceAttribute?.variation === true,
      definitionExternalId,
      assignmentExternalId: `assignment:${sourceProductId}:${sourceKey}`,
      terms,
      termsBySourceKey,
      ambiguousTermKeys,
    });
  });

  return { sourceProductId, dimensions };
}

function sourceAttributeKey(attribute, productPlan) {
  const globalId = Number(attribute?.id || 0);
  if (globalId > 0) return `global:${globalId}`;
  const customKey = `product:${productPlan.sourceProductId}:${canonicalKey(attribute?.name)}`;
  return customKey;
}

function selectVariationTerms(wcVariation, productPlan) {
  const selected = [];
  const errors = [];
  const omitted = [];
  const dimensionsByKey = new Map(productPlan.dimensions.map((dimension) => [dimension.sourceKey, dimension]));

  for (const attribute of Array.isArray(wcVariation?.attributes) ? wcVariation.attributes : []) {
    const key = sourceAttributeKey(attribute, productPlan);
    const dimension = dimensionsByKey.get(key);
    if (!dimension) {
      errors.push({ code: "UNKNOWN_ATTRIBUTE", sourceKey: key });
      continue;
    }
    if (!dimension.isVariation) continue;
    const optionKey = canonicalKey(attribute?.option);
    if (dimension.ambiguousTermKeys?.has(optionKey)) {
      errors.push({ code: "AMBIGUOUS_TERM", sourceKey: key, optionKey });
      continue;
    }
    const term = dimension.termsBySourceKey.get(optionKey);
    if (!term) {
      errors.push({ code: "UNKNOWN_TERM", sourceKey: key, optionKey });
      continue;
    }
    selected.push({ dimension, term });
  }

  const variationDimensions = productPlan.dimensions.filter(
    (dimension) => dimension.isVariation,
  );
  const selectedKeys = new Set(selected.map(({ dimension }) => dimension.sourceKey));
  variationDimensions.forEach((dimension) => {
    if (selectedKeys.has(dimension.sourceKey)) return;

    // Woo permits a variation to leave pa_size unset. The destination size
    // relation is optional too, so preserve that absence instead of fabricating
    // a synthetic size or rejecting an otherwise valid variation.
    if (dimension.legacyProjection === "Size") {
      omitted.push({ code: "OPTIONAL_SIZE_UNSET", sourceKey: dimension.sourceKey });
      return;
    }

    errors.push({ code: "MISSING_VARIATION_TERM", sourceKey: dimension.sourceKey });
  });

  return { selected, errors, omitted };
}

/**
 * Resolve one Woo variation's selected values to the exact Strapi relation ids.
 * This is the canonical writer used by catalog imports, order-completeness
 * repair, and the historical-data repair command. It deliberately returns the
 * complete relation shape (including explicit nulls/empty arrays) so a retry
 * cannot retain stale values from an older source variation.
 */
function buildVariationAttributePayload(wcVariation, productPlan, resolvedDimensions) {
  const selection = selectVariationTerms(wcVariation, productPlan);
  if (selection.errors.length > 0) {
    const error = new Error(
      `Variation attribute mapping failed: ${selection.errors.map((item) => item.code).join(",")}`,
    );
    error.code = "VARIATION_ATTRIBUTE_MAPPING_FAILED";
    error.details = selection.errors;
    throw error;
  }
  if (!resolvedDimensions) {
    throw new Error("Resolved product attributes are required for a variation write");
  }

  const payload = {
    product_variation_color: null,
    product_variation_size: null,
    product_variation_model: null,
    selected_attribute_terms: [],
    AttributeSignature: "",
  };
  const signatureTokens = [];

  for (const { dimension, term } of selection.selected) {
    const resolvedDimension = resolvedDimensions.get(dimension.sourceKey);
    const resolvedTerm = resolvedDimension?.resolvedTerms?.get(term.sourceKey);
    if (!resolvedDimension?.definitionId || !resolvedTerm?.id) {
      const error = new Error(
        `Resolved attribute term missing: ${dimension.sourceKey}/${term.sourceKey}`,
      );
      error.code = "RESOLVED_VARIATION_TERM_MISSING";
      throw error;
    }

    if (dimension.legacyProjection === "Color") {
      if (!resolvedTerm.legacyId) throw new Error(`Legacy color projection missing: ${term.title}`);
      payload.product_variation_color = resolvedTerm.legacyId;
      signatureTokens.push(`color=${resolvedTerm.legacyId}`);
    } else if (dimension.legacyProjection === "Size") {
      if (!resolvedTerm.legacyId) throw new Error(`Legacy size projection missing: ${term.title}`);
      payload.product_variation_size = resolvedTerm.legacyId;
      signatureTokens.push(`size=${resolvedTerm.legacyId}`);
    } else if (dimension.legacyProjection === "Model") {
      if (!resolvedTerm.legacyId) throw new Error(`Legacy model projection missing: ${term.title}`);
      payload.product_variation_model = resolvedTerm.legacyId;
      signatureTokens.push(`model=${resolvedTerm.legacyId}`);
    } else {
      payload.selected_attribute_terms.push(resolvedTerm.id);
      signatureTokens.push(`attribute:${resolvedDimension.definitionId}=${resolvedTerm.id}`);
    }
  }

  payload.selected_attribute_terms.sort((left, right) => left - right);
  payload.AttributeSignature = signatureTokens.sort().join("|");
  return payload;
}

function definitionPayload(dimension, ownerProductId) {
  return {
    Title: dimension.title,
    Slug: dimension.slug,
    Scope: dimension.scope,
    Type: dimension.type,
    LegacyProjection: dimension.legacyProjection,
    Position: dimension.position,
    owner_product: dimension.scope === "Product" ? ownerProductId : null,
    external_id: dimension.definitionExternalId,
    external_source: EXTERNAL_SOURCE,
  };
}

function termPayload(term, definitionId) {
  return {
    Title: term.title,
    Slug: term.slug || null,
    ColorCode: term.colorCode || null,
    Position: term.position,
    product_attribute: definitionId,
    external_id: term.externalId,
    external_source: EXTERNAL_SOURCE,
  };
}

function assignmentPayload(dimension, productId, definitionId, termIds) {
  return {
    Position: dimension.position,
    IsVisible: dimension.isVisible,
    IsVariation: dimension.isVariation,
    product: productId,
    product_attribute: definitionId,
    terms: termIds,
    external_id: dimension.assignmentExternalId,
    external_source: EXTERNAL_SOURCE,
  };
}

module.exports = {
  EXTERNAL_SOURCE,
  canonicalKey,
  legacyProjection,
  attributeType,
  buildProductAttributePlan,
  selectVariationTerms,
  buildVariationAttributePayload,
  definitionPayload,
  termPayload,
  assignmentPayload,
};
