"use strict";

const G = require("./genericAttributes");

const asIds = (value) => (Array.isArray(value) ? value : [])
  .map(Number)
  .filter((id) => Number.isInteger(id) && id > 0)
  .sort((left, right) => left - right);

const sameIds = (left, right) => JSON.stringify(asIds(left)) === JSON.stringify(asIds(right));

function canonicalCurrentPayload(variation) {
  const selected = [...(variation.selectedTerms || [])];
  const tokens = [];
  for (const id of asIds(variation.colorIds)) tokens.push(`color=${id}`);
  for (const id of asIds(variation.sizeIds)) tokens.push(`size=${id}`);
  for (const id of asIds(variation.modelIds)) tokens.push(`model=${id}`);
  for (const term of selected) {
    const attributeId = Number(term.attributeId);
    const termId = Number(term.id);
    if (attributeId > 0 && termId > 0) tokens.push(`attribute:${attributeId}=${termId}`);
  }
  return {
    selected_attribute_terms: asIds(selected.map((term) => term.id)),
    AttributeSignature: tokens.sort().join("|"),
  };
}

function classifyProduct(product) {
  const reasons = [];
  const assignmentKeys = new Set();
  const attributeIds = new Set();
  for (const assignment of product.genericAssignments || []) {
    const key = String(assignment.externalId || "");
    if (!key || assignmentKeys.has(key) || attributeIds.has(Number(assignment.attributeId))) {
      reasons.push("AMBIGUOUS_ASSIGNMENT");
    }
    assignmentKeys.add(key);
    attributeIds.add(Number(assignment.attributeId));
    const allowed = asIds((assignment.terms || []).map((term) => term.id));
    if (allowed.length !== (assignment.terms || []).length) reasons.push("AMBIGUOUS_ASSIGNMENT_TERM");
  }

  const variationIds = new Set();
  const variationExternalIds = new Set();
  let inconsistent = false;
  for (const variation of product.variations || []) {
    if (variationIds.has(Number(variation.id)) || variationExternalIds.has(String(variation.externalId))) {
      reasons.push("AMBIGUOUS_VARIATION_IDENTITY");
    }
    variationIds.add(Number(variation.id));
    variationExternalIds.add(String(variation.externalId));
    if ((variation.productIds || []).length !== 1 || Number(variation.productIds[0]) !== Number(product.id)) {
      reasons.push("AMBIGUOUS_PRODUCT_RELATION");
    }
    if ((variation.stocks || []).length > 1 || asIds(variation.colorIds).length > 1
      || asIds(variation.sizeIds).length > 1 || asIds(variation.modelIds).length > 1) {
      reasons.push("AMBIGUOUS_SINGLE_RELATION");
    }

    const selectedByAttribute = new Map();
    const seenTerms = new Set();
    for (const term of variation.selectedTerms || []) {
      const termId = Number(term.id);
      const attributeId = Number(term.attributeId);
      if (!termId || !attributeId || seenTerms.has(termId)) reasons.push("AMBIGUOUS_SELECTED_TERM");
      seenTerms.add(termId);
      const rows = selectedByAttribute.get(attributeId) || [];
      rows.push(termId);
      selectedByAttribute.set(attributeId, rows);
    }

    for (const assignment of product.genericAssignments || []) {
      const selectedIds = selectedByAttribute.get(Number(assignment.attributeId)) || [];
      const allowed = new Set((assignment.terms || []).map((term) => Number(term.id)));
      if (selectedIds.length > 1 || selectedIds.some((termId) => !allowed.has(termId))) {
        reasons.push("AMBIGUOUS_SELECTED_TERM");
      }
      if (selectedIds.length !== 1) inconsistent = true;
      selectedByAttribute.delete(Number(assignment.attributeId));
    }
    if (selectedByAttribute.size > 0) reasons.push("AMBIGUOUS_EXTRANEOUS_TERM");

    if (String(variation.attributeSignature || "") !== canonicalCurrentPayload(variation).AttributeSignature) {
      inconsistent = true;
    }
  }

  const uniqueReasons = [...new Set(reasons)].sort();
  return {
    status: uniqueReasons.length > 0 ? "ambiguous" : inconsistent ? "candidate" : "healthy",
    reasons: uniqueReasons,
  };
}

function classifyPopulation(products) {
  const summary = { products: { candidate: 0, healthy: 0, ambiguous: 0 }, variations: { candidate: 0, healthy: 0, ambiguous: 0 } };
  const classified = products.map((product) => {
    const classification = classifyProduct(product);
    summary.products[classification.status] += 1;
    summary.variations[classification.status] += (product.variations || []).length;
    return { ...product, classification };
  });
  return { products: classified, summary };
}

function uniqueByExternal(rows, label) {
  const map = new Map();
  for (const row of rows || []) {
    const key = String(row.externalId || "");
    if (!key || map.has(key)) {
      const error = new Error(`${label}_AMBIGUOUS:${key || "missing"}`);
      error.code = `${label}_AMBIGUOUS`;
      throw error;
    }
    map.set(key, row);
  }
  return map;
}

function resolveProductPlan(product, sourceProduct, registry, legacyMaps) {
  if (String(sourceProduct?.id) !== String(product.externalId)) {
    throw new Error("SOURCE_PRODUCT_IDENTITY_MISMATCH");
  }
  const plan = G.buildProductAttributePlan(sourceProduct, registry);
  const assignments = uniqueByExternal(product.genericAssignments, "DESTINATION_ASSIGNMENT");
  const resolvedDimensions = new Map();

  for (const dimension of plan.dimensions.filter((item) => item.isVariation)) {
    const resolvedTerms = new Map();
    if (dimension.legacyProjection === "None") {
      const assignment = assignments.get(dimension.assignmentExternalId);
      if (!assignment || assignment.definitionExternalId !== dimension.definitionExternalId) {
        throw new Error(`DESTINATION_ASSIGNMENT_MISSING:${dimension.assignmentExternalId}`);
      }
      const terms = uniqueByExternal(assignment.terms, "DESTINATION_TERM");
      for (const term of dimension.terms) {
        const resolved = terms.get(term.externalId);
        if (!resolved?.id) throw new Error(`DESTINATION_TERM_MISSING:${term.externalId}`);
        resolvedTerms.set(term.sourceKey, { ...term, id: Number(resolved.id), legacyId: null });
      }
      resolvedDimensions.set(dimension.sourceKey, {
        ...dimension,
        definitionId: Number(assignment.attributeId),
        assignmentId: Number(assignment.id),
        resolvedTerms,
      });
      continue;
    }

    const legacy = legacyMaps[dimension.legacyProjection];
    if (!legacy) throw new Error(`UNSUPPORTED_LEGACY_PROJECTION:${dimension.legacyProjection}`);
    for (const term of dimension.terms) {
      const rows = legacy.get(term.externalId) || [];
      if (rows.length !== 1) throw new Error(`LEGACY_TERM_NOT_EXACT:${term.externalId}`);
      resolvedTerms.set(term.sourceKey, { ...term, id: Number(rows[0]), legacyId: Number(rows[0]) });
    }
    resolvedDimensions.set(dimension.sourceKey, {
      ...dimension,
      definitionId: -1,
      resolvedTerms,
    });
  }

  return { plan, resolvedDimensions };
}

function desiredForVariation(sourceVariation, context) {
  return G.buildVariationAttributePayload(
    sourceVariation,
    context.plan,
    context.resolvedDimensions,
  );
}

function variationNeedsRepair(variation, desired) {
  return !sameIds(
    (variation.selectedTerms || []).map((term) => term.id),
    desired.selected_attribute_terms,
  ) || String(variation.attributeSignature || "") !== String(desired.AttributeSignature || "")
    || Number(variation.colorIds?.[0] || 0) !== Number(desired.product_variation_color || 0)
    || Number(variation.sizeIds?.[0] || 0) !== Number(desired.product_variation_size || 0)
    || Number(variation.modelIds?.[0] || 0) !== Number(desired.product_variation_model || 0);
}

function identityOf(variation) {
  const stock = (variation.stocks || [])[0] || {};
  return {
    id: Number(variation.id),
    productId: Number(variation.productIds?.[0]),
    externalId: String(variation.externalId || ""),
    sku: variation.sku ?? null,
    price: variation.price ?? null,
    discountPrice: variation.discountPrice ?? null,
    stockId: stock.id ?? null,
    stock: stock.count ?? null,
    reservedStock: stock.reservedCount ?? null,
    isPublished: variation.isPublished === true,
  };
}

function assertIdentityUnchanged(before, after) {
  const beforeRows = [...before].map(identityOf).sort((a, b) => a.id - b.id);
  const afterRows = [...after].map(identityOf).sort((a, b) => a.id - b.id);
  if (JSON.stringify(beforeRows) !== JSON.stringify(afterRows)) {
    const error = new Error("VARIATION_IDENTITY_CHANGED");
    error.code = "VARIATION_IDENTITY_CHANGED";
    throw error;
  }
}

module.exports = {
  canonicalCurrentPayload,
  classifyProduct,
  classifyPopulation,
  resolveProductPlan,
  desiredForVariation,
  variationNeedsRepair,
  identityOf,
  assertIdentityUnchanged,
};
