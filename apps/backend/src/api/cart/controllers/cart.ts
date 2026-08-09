/**
 * cart controller
 */

import { factories } from "@strapi/strapi";
import { Strapi } from "@strapi/strapi";
import { applyDiscountHandler } from "./handlers/applyDiscount";
import { getMyCartHandler } from "./handlers/getMyCart";
import { addItemHandler } from "./handlers/addItem";
import { updateItemHandler } from "./handlers/updateItem";
import { removeItemHandler } from "./handlers/removeItem";
import { checkStockHandler } from "./handlers/checkStock";
import { finalizeToOrderHandler } from "./handlers/finalizeToOrder";
import { shippingPreviewHandler } from "./handlers/shippingPreview";
import { shippingOptionsHandler } from "./handlers/shippingOptions";
import { checkoutQuoteHandler } from "./handlers/checkoutQuote";
import { mergeGuestCartHandler } from "./handlers/mergeGuestCart";
import { requireCapability } from "../../../utils/adminAuthorization";

type QueryRecord = Record<string, unknown>;

const asRecord = (value: unknown): QueryRecord | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as QueryRecord)
    : null;

const pickOperators = (
  value: unknown,
  allowed: ReadonlySet<string>,
): QueryRecord | string | string[] | undefined => {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }

  const record = asRecord(value);
  if (!record) return undefined;

  const result = Object.fromEntries(
    Object.entries(record).filter(
      ([operator, operand]) =>
        allowed.has(operator) &&
        (typeof operand === "string" ||
          (Array.isArray(operand) && operand.every((item) => typeof item === "string"))),
    ),
  );
  return Object.keys(result).length > 0 ? result : undefined;
};

const buildCartReportFilters = (value: unknown): QueryRecord => {
  const filters = asRecord(value);
  if (!filters) return {};

  const result: QueryRecord = {};
  const status = pickOperators(
    filters.Status ?? filters.status,
    new Set(["$eq", "$in", "$ne"]),
  );
  if (status !== undefined) result.Status = status;

  const createdAt = pickOperators(
    filters.createdAt,
    new Set(["$eq", "$gte", "$lte", "$gt", "$lt"]),
  );
  if (createdAt !== undefined) result.createdAt = createdAt;

  const user = asRecord(filters.user);
  if (user) {
    const userFilter: QueryRecord = {};
    const phone = pickOperators(
      user.Phone ?? user.phone,
      new Set(["$eq", "$contains", "$containsi"]),
    );
    if (phone !== undefined) userFilter.Phone = phone;

    const userInfo = asRecord(user.user_info);
    if (userInfo) {
      const userInfoFilter: QueryRecord = {};
      for (const field of ["FirstName", "LastName"] as const) {
        const filter = pickOperators(
          userInfo[field],
          new Set(["$eq", "$contains", "$containsi"]),
        );
        if (filter !== undefined) userInfoFilter[field] = filter;
      }
      if (Object.keys(userInfoFilter).length > 0) {
        userFilter.user_info = userInfoFilter;
      }
    }

    if (Object.keys(userFilter).length > 0) result.user = userFilter;
  }

  return result;
};

const boundedPagination = (value: unknown) => {
  const pagination = asRecord(value);
  const page = Math.max(1, Number.parseInt(String(pagination?.page ?? "1"), 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(String(pagination?.pageSize ?? "25"), 10) || 25),
  );
  return { page, pageSize };
};

export default factories.createCoreController(
  "api::cart.cart",
  ({ strapi }: { strapi: Strapi }) => ({
    async find(ctx) {
      if (!(await requireCapability(ctx, strapi, "report.carts.read"))) return;

      // Cart reporting is deliberately a fixed projection. In particular, do
      // not honor caller-supplied fields/populate/sort directives because the
      // generic cart graph reaches customer and product data that this screen
      // neither needs nor may expose.
      const safeQuery: any = {
        fields: ["Status", "createdAt"],
        filters: buildCartReportFilters(ctx.query?.filters),
        pagination: boundedPagination(ctx.query?.pagination),
        sort: ["createdAt:desc"],
        populate: {
          user: {
            fields: ["Phone"],
            populate: {
              user_info: { fields: ["FirstName", "LastName"] },
            },
          },
          cart_items: {
            fields: ["Sum", "Count"],
            populate: {
              product_variation: {
                fields: ["id"],
                populate: {
                  product: {
                    fields: ["Title"],
                    populate: {
                      CoverImage: { fields: ["name", "url", "formats"] },
                    },
                  },
                },
              },
            },
          },
        },
      };
      ctx.query = safeQuery;

      return super.find(ctx);
    },

    async applyDiscount(ctx) {
      return applyDiscountHandler(strapi)(ctx);
    },

    async getMyCart(ctx) {
      return getMyCartHandler(strapi)(ctx);
    },

    async addItem(ctx) {
      return addItemHandler(strapi)(ctx);
    },

    async mergeGuestCart(ctx) {
      return mergeGuestCartHandler(strapi)(ctx);
    },

    async updateItem(ctx) {
      return updateItemHandler(strapi)(ctx);
    },

    async removeItem(ctx) {
      return removeItemHandler(strapi)(ctx);
    },

    async checkStock(ctx) {
      return checkStockHandler(strapi)(ctx);
    },

    async finalizeToOrder(ctx) {
      return finalizeToOrderHandler(strapi)(ctx);
    },

    async checkoutQuote(ctx) {
      return checkoutQuoteHandler(strapi)(ctx);
    },

    async shippingPreview(ctx) {
      return shippingPreviewHandler(strapi)(ctx);
    },

    async shippingOptions(ctx) {
      return shippingOptionsHandler(strapi)(ctx);
    },
  })
);
