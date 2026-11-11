/**
 * shipping service
 */

import { factories } from "@strapi/strapi";
import { chargeableVariationPrice } from "../../../utils/productAvailability";
import {
  evaluateShippingMethod,
  validateShippingRulesConfig,
  type ShippingContext,
} from "./rules";

type AddressContext = {
  addressId?: number | string | null;
  addressPayload?: {
    shipping_city?: number | string | null;
  } | null;
};

type ShippingCalculationOptions = {
  cart?: any;
  context?: ShippingContext;
};

const normalizeId = (value: unknown): number | undefined => {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
};

const normalizeRole = (value: unknown): string | undefined => {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || undefined;
};

const extractMethodPayload = (method: any, price: number, matchedRule: any) => ({
  id: method.id,
  code: method.Code || String(method.id),
  title: method.Title,
  description: method.Description || "",
  estimatedDeliveryText: method.EstimatedDeliveryText || "",
  price,
  basePrice: Math.max(0, Math.round(Number(method.Price || 0))),
  sortOrder: Number(method.SortOrder || 0),
  icon: method.Icon || null,
  matchedRule,
});

export default factories.createCoreService("api::shipping.shipping", ({ strapi }) => ({
  validateShippingRulesConfig(rules: unknown) {
    return validateShippingRulesConfig(rules);
  },

  async create(params: any) {
    if (params?.data && Object.prototype.hasOwnProperty.call(params.data, "Rules")) {
      params.data.Rules = validateShippingRulesConfig(params.data.Rules);
    }
    return super.create(params);
  },

  async update(entityId: any, params: any) {
    if (params?.data && Object.prototype.hasOwnProperty.call(params.data, "Rules")) {
      params.data.Rules = validateShippingRulesConfig(params.data.Rules);
    }
    return super.update(entityId, params);
  },

  async getShippingContext(
    userId: number,
    addressContext: AddressContext = {},
    options: ShippingCalculationOptions = {},
  ): Promise<ShippingContext> {
    if (options.context) {
      return options.context;
    }

    const cartService = strapi.service("api::cart.cart");
    const cart = options.cart ?? (await cartService.getUserCart(userId));

    let subtotal = 0;
    let quantity = 0;
    let weight = 0;
    const productIds = new Set<number>();
    const categoryIds = new Set<number>();

    for (const item of cart?.cart_items || []) {
      const count = Number(item?.Count || 0);
      const variation = item?.product_variation;
      const product = variation?.product;
      const price = chargeableVariationPrice(variation);
      subtotal += price * count;
      quantity += count;
      weight += Math.max(0, Number(product?.Weight ?? 100) || 100) * count;

      const productId = normalizeId(product?.id);
      if (productId) productIds.add(productId);
      const categoryId = normalizeId(product?.product_main_category?.id);
      if (categoryId) categoryIds.add(categoryId);
    }

    let cityId: number | undefined;
    let provinceId: number | undefined;
    const addressId = normalizeId(addressContext.addressId);
    const inlineCityId = normalizeId(addressContext.addressPayload?.shipping_city);

    if (addressId) {
      const address: any = await strapi.entityService.findOne(
        "api::local-user-address.local-user-address",
        addressId,
        {
          populate: {
            user: true,
            shipping_city: { populate: { shipping_province: true } },
          },
        }
      );
      const addressUserId = normalizeId(address?.user?.id ?? address?.user);
      if (!address || Number(addressUserId) !== Number(userId)) {
        throw new Error("ADDRESS_UNAUTHORIZED");
      }
      cityId = normalizeId(address?.shipping_city?.id ?? address?.shipping_city);
      provinceId = normalizeId(address?.shipping_city?.shipping_province?.id);
    } else if (inlineCityId) {
      const city: any = await strapi.entityService.findOne(
        "api::shipping-city.shipping-city",
        inlineCityId,
        { populate: { shipping_province: true } }
      );
      if (!city) {
        throw new Error("INVALID_CITY");
      }
      cityId = normalizeId(city.id);
      provinceId = normalizeId(city?.shipping_province?.id);
    }

    const roleTypes = new Set<string>();
    // A Bale bot quote has no account yet (userId 0): role rules cannot match.
    if (Number(userId) > 0) try {
      const user: any = await strapi.entityService.findOne(
        "plugin::users-permissions.user",
        userId,
        {
          populate: {
            role: true,
            user_role: true,
          },
        }
      );
      for (const roleValue of [
        user?.role?.type,
        user?.role?.name,
        user?.user_role?.Type,
        user?.user_role?.Title,
      ]) {
        const normalized = normalizeRole(roleValue);
        if (normalized) roleTypes.add(normalized);
      }
    } catch (error) {
      strapi.log.warn("Could not load user roles for shipping rules", {
        userId,
        error: (error as Error)?.message || error,
      });
    }

    return {
      subtotal: Math.round(subtotal),
      quantity,
      weight: weight > 0 ? Math.round(weight) : 0,
      provinceId,
      cityId,
      roleTypes: Array.from(roleTypes),
      productIds: Array.from(productIds),
      categoryIds: Array.from(categoryIds),
    };
  },

  async getAvailableMethodsForCart(
    userId: number,
    addressContext: AddressContext = {},
    options: ShippingCalculationOptions = {},
  ) {
    const context = await this.getShippingContext(userId, addressContext, options);
    const methods: any[] = await strapi.entityService.findMany(
      "api::shipping.shipping",
      {
        filters: {
          IsActive: true,
          removedAt: { $null: true },
        },
        populate: { Icon: true },
        sort: ["SortOrder:asc", "Price:asc", "id:asc"],
        limit: -1,
      } as any
    );

    return methods
      .map((method) => {
        const evaluation = evaluateShippingMethod(method, context);
        if (!evaluation.eligible) return null;
        return extractMethodPayload(method, evaluation.price, evaluation.matchedRule);
      })
      .filter(Boolean);
  },

  async calculateMethodForCart(
    userId: number,
    shippingId: number | string,
    addressContext: AddressContext = {},
    options: ShippingCalculationOptions = {},
  ) {
    const normalizedShippingId = normalizeId(shippingId);
    if (!normalizedShippingId) {
      throw new Error("SHIPPING_REQUIRED");
    }

    const availableMethods = await this.getAvailableMethodsForCart(userId, addressContext, options);
    const selected = availableMethods.find((method: any) => Number(method.id) === normalizedShippingId);
    if (!selected) {
      throw new Error("INVALID_SHIPPING");
    }
    return selected;
  },
}));
