export type ShippingRule = {
  id?: string;
  title?: string;
  active?: boolean;
  priority?: number;
  minSubtotal?: number | null;
  maxSubtotal?: number | null;
  minQuantity?: number | null;
  maxQuantity?: number | null;
  minWeight?: number | null;
  maxWeight?: number | null;
  provinceIds?: number[];
  cityIds?: number[];
  excludedProvinceIds?: number[];
  excludedCityIds?: number[];
  roleTypes?: string[];
  productIds?: number[];
  categoryIds?: number[];
  price?: number | null;
  freeShippingThreshold?: number | null;
};

export type ShippingContext = {
  subtotal: number;
  quantity: number;
  weight: number;
  provinceId?: number | null;
  cityId?: number | null;
  roleTypes: string[];
  productIds: number[];
  categoryIds: number[];
};

export type ShippingEvaluation = {
  eligible: boolean;
  price: number;
  matchedRule: Pick<ShippingRule, "id" | "title" | "priority"> | null;
};

const NUMBER_FIELDS: Array<keyof ShippingRule> = [
  "priority",
  "minSubtotal",
  "maxSubtotal",
  "minQuantity",
  "maxQuantity",
  "minWeight",
  "maxWeight",
  "price",
  "freeShippingThreshold",
];

const ID_ARRAY_FIELDS: Array<keyof ShippingRule> = [
  "provinceIds",
  "cityIds",
  "excludedProvinceIds",
  "excludedCityIds",
  "productIds",
  "categoryIds",
];

const toFiniteNumber = (value: unknown): number | null => {
  if (value === "" || value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizeIds = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0)
    )
  );
};

const normalizeRoleTypes = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => String(item || "").trim().toLowerCase())
        .filter(Boolean)
    )
  );
};

export const validateShippingRulesConfig = (rules: unknown): ShippingRule[] => {
  if (rules === null || rules === undefined || rules === "") return [];
  if (!Array.isArray(rules)) {
    throw new Error("Shipping rules must be an array");
  }
  if (rules.length > 50) {
    throw new Error("Shipping rules cannot contain more than 50 entries");
  }

  return rules.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Shipping rule ${index + 1} must be an object`);
    }

    const source = raw as Record<string, unknown>;
    const rule: ShippingRule = {
      id: source.id ? String(source.id) : undefined,
      title: source.title ? String(source.title) : undefined,
      active: source.active === undefined ? true : Boolean(source.active),
      priority: toFiniteNumber(source.priority) ?? 0,
      roleTypes: normalizeRoleTypes(source.roleTypes),
    };

    for (const field of NUMBER_FIELDS) {
      if (field === "priority") continue;
      const value = toFiniteNumber(source[field as string]);
      if (value !== null) {
        if (value < 0) {
          throw new Error(`Shipping rule ${index + 1} has a negative ${String(field)}`);
        }
        (rule as Record<string, unknown>)[field] = value;
      }
    }

    for (const field of ID_ARRAY_FIELDS) {
      (rule as Record<string, unknown>)[field] = normalizeIds(source[field as string]);
    }

    const ranges: Array<[keyof ShippingRule, keyof ShippingRule, string]> = [
      ["minSubtotal", "maxSubtotal", "subtotal"],
      ["minQuantity", "maxQuantity", "quantity"],
      ["minWeight", "maxWeight", "weight"],
    ];
    for (const [minField, maxField, label] of ranges) {
      const min = rule[minField] as number | undefined;
      const max = rule[maxField] as number | undefined;
      if (min !== undefined && max !== undefined && min > max) {
        throw new Error(`Shipping rule ${index + 1} has invalid ${label} range`);
      }
    }

    return rule;
  });
};

const hasRestriction = (values?: unknown[]) => Array.isArray(values) && values.length > 0;

const intersects = (left: number[], right: number[]) =>
  left.some((item) => right.includes(item));

const roleIntersects = (left: string[], right: string[]) =>
  left.some((item) => right.includes(item));

export const shippingRuleMatches = (
  rule: ShippingRule,
  context: ShippingContext
): boolean => {
  if (rule.active === false) return false;
  if (rule.minSubtotal !== undefined && context.subtotal < Number(rule.minSubtotal)) return false;
  if (rule.maxSubtotal !== undefined && context.subtotal > Number(rule.maxSubtotal)) return false;
  if (rule.minQuantity !== undefined && context.quantity < Number(rule.minQuantity)) return false;
  if (rule.maxQuantity !== undefined && context.quantity > Number(rule.maxQuantity)) return false;
  if (rule.minWeight !== undefined && context.weight < Number(rule.minWeight)) return false;
  if (rule.maxWeight !== undefined && context.weight > Number(rule.maxWeight)) return false;

  if (hasRestriction(rule.provinceIds)) {
    if (!context.provinceId || !rule.provinceIds?.includes(Number(context.provinceId))) return false;
  }
  if (hasRestriction(rule.cityIds)) {
    if (!context.cityId || !rule.cityIds?.includes(Number(context.cityId))) return false;
  }
  if (
    hasRestriction(rule.excludedProvinceIds) &&
    context.provinceId &&
    rule.excludedProvinceIds?.includes(Number(context.provinceId))
  ) {
    return false;
  }
  if (
    hasRestriction(rule.excludedCityIds) &&
    context.cityId &&
    rule.excludedCityIds?.includes(Number(context.cityId))
  ) {
    return false;
  }
  if (hasRestriction(rule.productIds) && !intersects(rule.productIds || [], context.productIds)) {
    return false;
  }
  if (hasRestriction(rule.categoryIds) && !intersects(rule.categoryIds || [], context.categoryIds)) {
    return false;
  }
  if (hasRestriction(rule.roleTypes) && !roleIntersects(rule.roleTypes || [], context.roleTypes)) {
    return false;
  }

  return true;
};

export const evaluateShippingMethod = (
  method: { Price?: number | null; Rules?: unknown },
  context: ShippingContext
): ShippingEvaluation => {
  const basePrice = Math.max(0, Math.round(Number(method.Price || 0)));
  const rules = validateShippingRulesConfig(method.Rules);
  const activeRules = rules.filter((rule) => rule.active !== false);

  if (activeRules.length === 0) {
    return {
      eligible: true,
      price: basePrice,
      matchedRule: null,
    };
  }

  const matchedRule = activeRules
    .filter((rule) => shippingRuleMatches(rule, context))
    .sort((left, right) => Number(right.priority || 0) - Number(left.priority || 0))[0];

  if (!matchedRule) {
    return {
      eligible: false,
      price: basePrice,
      matchedRule: null,
    };
  }

  let price =
    matchedRule.price !== undefined && matchedRule.price !== null
      ? Math.max(0, Math.round(Number(matchedRule.price)))
      : basePrice;

  if (
    matchedRule.freeShippingThreshold !== undefined &&
    matchedRule.freeShippingThreshold !== null &&
    context.subtotal >= Number(matchedRule.freeShippingThreshold)
  ) {
    price = 0;
  }

  return {
    eligible: true,
    price,
    matchedRule: {
      id: matchedRule.id,
      title: matchedRule.title,
      priority: matchedRule.priority,
    },
  };
};
