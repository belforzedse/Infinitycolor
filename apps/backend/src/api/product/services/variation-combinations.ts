import { createHash } from "node:crypto";

export type VariationAxis =
  | { type: "color" | "size" | "model"; termIds: number[] }
  | { type: "attribute"; attributeId: number; termIds: number[] };

type NormalizedAxis = {
  key: string;
  type: VariationAxis["type"];
  attributeId?: number;
  termIds: number[];
};

type VariationCombination = {
  signature: string;
  colorId?: number;
  sizeId?: number;
  modelId?: number;
  attributeTermIds: number[];
};

const MAX_AXES = 12;
const MAX_TERMS_PER_AXIS = 250;
export const MAX_VARIATION_COMBINATIONS = 5_000;

const asPositiveId = (value: unknown): number | null => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const relationId = (value: any): number | null => {
  const candidate = value?.data?.id ?? value?.id ?? value;
  return asPositiveId(candidate);
};

const relationArray = (value: any): any[] => {
  const data = value?.data ?? value;
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
};

const attrsOf = (value: any): any => value?.attributes ?? value ?? {};

export function normalizeVariationAxes(input: unknown): NormalizedAxis[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("At least one variation attribute is required");
  }
  if (input.length > MAX_AXES) {
    throw new Error(`A maximum of ${MAX_AXES} variation attributes is supported`);
  }

  const axes: NormalizedAxis[] = [];
  const seenKeys = new Set<string>();

  for (const raw of input) {
    if (!raw || typeof raw !== "object") throw new Error("Invalid variation attribute");
    const type = String((raw as any).type || "") as VariationAxis["type"];
    if (!["color", "size", "model", "attribute"].includes(type)) {
      throw new Error(`Unsupported variation attribute type: ${type || "missing"}`);
    }

    const attributeId = type === "attribute" ? asPositiveId((raw as any).attributeId) : null;
    if (type === "attribute" && !attributeId) {
      throw new Error("Generic variation attributes require a valid attributeId");
    }

    const key = type === "attribute" ? `attribute:${attributeId}` : type;
    if (seenKeys.has(key)) throw new Error(`Duplicate variation attribute: ${key}`);
    seenKeys.add(key);

    const ids = Array.isArray((raw as any).termIds) ? (raw as any).termIds : [];
    const termIds: number[] = Array.from(
      new Set<number>(ids.map(asPositiveId).filter((id): id is number => id !== null)),
    );
    if (termIds.length === 0) throw new Error(`Variation attribute ${key} has no values`);
    if (termIds.length > MAX_TERMS_PER_AXIS) {
      throw new Error(`Variation attribute ${key} exceeds ${MAX_TERMS_PER_AXIS} values`);
    }

    axes.push({ key, type, attributeId: attributeId || undefined, termIds });
  }

  const combinationCount = axes.reduce((count, axis) => count * axis.termIds.length, 1);
  if (!Number.isSafeInteger(combinationCount) || combinationCount > MAX_VARIATION_COMBINATIONS) {
    throw new Error(
      `Variation generation is limited to ${MAX_VARIATION_COMBINATIONS} combinations per request`,
    );
  }

  return axes;
}

export function buildAttributeSignature(tokens: Array<{ key: string; termId: number }>): string {
  return tokens
    .map(({ key, termId }) => ({ key, termId: asPositiveId(termId) }))
    .filter((token): token is { key: string; termId: number } => Boolean(token.key && token.termId))
    .sort((left, right) => left.key.localeCompare(right.key) || left.termId - right.termId)
    .map(({ key, termId }) => `${key}=${termId}`)
    .join("|");
}

export function buildVariationCombinations(axes: NormalizedAxis[]): VariationCombination[] {
  let partials: Array<Array<{ axis: NormalizedAxis; termId: number }>> = [[]];
  for (const axis of axes) {
    partials = partials.flatMap((partial) =>
      axis.termIds.map((termId) => [...partial, { axis, termId }]),
    );
  }

  return partials.map((parts) => {
    const combination: VariationCombination = {
      signature: buildAttributeSignature(
        parts.map(({ axis, termId }) => ({ key: axis.key, termId })),
      ),
      attributeTermIds: [],
    };

    for (const { axis, termId } of parts) {
      if (axis.type === "color") combination.colorId = termId;
      if (axis.type === "size") combination.sizeId = termId;
      if (axis.type === "model") combination.modelId = termId;
      if (axis.type === "attribute") combination.attributeTermIds.push(termId);
    }

    return combination;
  });
}

export function signatureFromVariation(variation: any): string {
  const attrs = attrsOf(variation);
  const tokens: Array<{ key: string; termId: number }> = [];
  const colorId = relationId(attrs.product_variation_color);
  const sizeId = relationId(attrs.product_variation_size);
  const modelId = relationId(attrs.product_variation_model);
  if (colorId) tokens.push({ key: "color", termId: colorId });
  if (sizeId) tokens.push({ key: "size", termId: sizeId });
  if (modelId) tokens.push({ key: "model", termId: modelId });

  for (const term of relationArray(attrs.selected_attribute_terms)) {
    const termId = relationId(term);
    const termAttrs = attrsOf(term);
    const attributeId = relationId(termAttrs.product_attribute);
    if (termId && attributeId) tokens.push({ key: `attribute:${attributeId}`, termId });
  }

  return buildAttributeSignature(tokens);
}

const generatedSku = (productId: number, signature: string): string => {
  const digest = createHash("sha256").update(`${productId}:${signature}`).digest("hex").slice(0, 20);
  return `GEN-${productId}-${digest}`;
};

const validateLegacyAxis = async (strapi: any, axis: NormalizedAxis) => {
  const uidByType: Record<string, string> = {
    color: "api::product-variation-color.product-variation-color",
    size: "api::product-variation-size.product-variation-size",
    model: "api::product-variation-model.product-variation-model",
  };
  const uid = uidByType[axis.type];
  if (!uid) return;

  const found = await strapi.entityService.findMany(uid, {
    filters: { id: { $in: axis.termIds } },
    fields: ["id"],
    limit: axis.termIds.length,
  });
  const foundIds = new Set((found as any[]).map((entity) => Number(entity.id)));
  const missing = axis.termIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) throw new Error(`Unknown ${axis.type} values: ${missing.join(", ")}`);
};

const validateGenericAxis = async (strapi: any, productId: number, axis: NormalizedAxis) => {
  const assignments = await strapi.entityService.findMany(
    "api::product-attribute-assignment.product-attribute-assignment",
    {
      filters: {
        product: { id: productId },
        product_attribute: { id: axis.attributeId },
        IsVariation: true,
      },
      populate: { terms: true },
      limit: 2,
    },
  );
  if ((assignments as any[]).length !== 1) {
    throw new Error(`Product attribute ${axis.attributeId} is not configured exactly once`);
  }

  const allowedIds = new Set(
    relationArray((assignments as any[])[0]?.terms).map((term) => relationId(term)),
  );
  const disallowed = axis.termIds.filter((id) => !allowedIds.has(id));
  if (disallowed.length > 0) {
    throw new Error(
      `Attribute ${axis.attributeId} contains values not assigned to this product: ${disallowed.join(", ")}`,
    );
  }
};

export async function generateVariationCombinations(
  strapi: any,
  productIdInput: unknown,
  axesInput: unknown,
) {
  const productId = asPositiveId(productIdInput);
  if (!productId) throw new Error("A valid product id is required");
  const axes = normalizeVariationAxes(axesInput);

  const product = await strapi.entityService.findOne("api::product.product", productId, {
    fields: ["id"],
  });
  if (!product) throw new Error("Product not found");

  await Promise.all(
    axes.map((axis) =>
      axis.type === "attribute"
        ? validateGenericAxis(strapi, productId, axis)
        : validateLegacyAxis(strapi, axis),
    ),
  );

  const combinations = buildVariationCombinations(axes);

  return strapi.db.transaction(async ({ trx }: { trx: any }) => {
    await trx.raw("SELECT pg_advisory_xact_lock(?, ?)", [845_733, productId]);

    const existing = await strapi.entityService.findMany(
      "api::product-variation.product-variation",
      {
        filters: { product: { id: productId } },
        fields: ["id", "AttributeSignature"],
        populate: {
          product_variation_color: { fields: ["id"] },
          product_variation_size: { fields: ["id"] },
          product_variation_model: { fields: ["id"] },
          selected_attribute_terms: {
            fields: ["id"],
            populate: { product_attribute: { fields: ["id"] } },
          },
        },
        limit: MAX_VARIATION_COMBINATIONS,
        transacting: trx,
      } as any,
    );

    const existingSignatures = new Set(
      (existing as any[])
        .map((variation) =>
          String(variation.AttributeSignature || signatureFromVariation(variation)).trim(),
        )
        .filter(Boolean),
    );
    const createdIds: number[] = [];
    const skippedSignatures: string[] = [];

    for (const combination of combinations) {
      if (existingSignatures.has(combination.signature)) {
        skippedSignatures.push(combination.signature);
        continue;
      }

      const data: Record<string, unknown> = {
        product: productId,
        SKU: generatedSku(productId, combination.signature),
        Price: 0,
        DiscountPrice: null,
        IsPublished: false,
        AttributeSignature: combination.signature,
        selected_attribute_terms: combination.attributeTermIds,
      };
      if (combination.colorId) data.product_variation_color = combination.colorId;
      if (combination.sizeId) data.product_variation_size = combination.sizeId;
      if (combination.modelId) data.product_variation_model = combination.modelId;

      const created = await strapi.entityService.create(
        "api::product-variation.product-variation",
        { data, transacting: trx } as any,
      );
      createdIds.push(Number((created as any).id));
      existingSignatures.add(combination.signature);
    }

    return {
      productId,
      requested: combinations.length,
      created: createdIds.length,
      skipped: skippedSignatures.length,
      createdIds,
      skippedSignatures,
    };
  });
}
