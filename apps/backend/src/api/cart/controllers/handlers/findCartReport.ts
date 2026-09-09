import type { Strapi } from "@strapi/strapi";
import { adminPagination } from "../../../../utils/admin-list-query";

type QueryRecord = Record<string, unknown>;

type CartReportContext = {
  query?: QueryRecord;
  body?: unknown;
  set?: (name: string, value: string) => void;
};

const CART_REPORT_POPULATE = {
  user: {
    select: ["id", "phone"],
    populate: {
      user_info: { select: ["id", "FirstName", "LastName"] },
    },
  },
  cart_items: {
    select: ["id", "Sum", "Count"],
    populate: {
      product_variation: {
        select: ["id"],
        populate: {
          product: {
            select: ["id", "Title"],
            populate: {
              CoverImage: {
                select: ["id", "name", "url", "formats"],
              },
            },
          },
        },
      },
    },
  },
} as const;

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
          (Array.isArray(operand) &&
            operand.every((item) => typeof item === "string"))),
    ),
  );
  return Object.keys(result).length > 0 ? result : undefined;
};

export const buildCartReportFilters = (value: unknown): QueryRecord => {
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
    // users-permissions stores the number as `phone`; never query `Phone`.
    if (phone !== undefined) userFilter.phone = phone;

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

export const boundedCartReportPagination = (value: unknown) => {
  const pagination = asRecord(value);
  const page = Math.max(
    1,
    Number.parseInt(String(pagination?.page ?? "1"), 10) || 1,
  );
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(String(pagination?.pageSize ?? "25"), 10) || 25),
  );
  return { page, pageSize };
};

const unwrapRelation = (value: unknown): QueryRecord | null => {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const first = value[0];
    return asRecord(first);
  }
  const record = asRecord(value);
  if (!record) return null;
  if ("data" in record) {
    const nested = record.data;
    if (Array.isArray(nested)) return asRecord(nested[0]);
    return asRecord(nested);
  }
  return record;
};

const unwrapCollection = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record && Array.isArray(record.data)) return record.data;
  return [];
};

const projectCoverImage = (value: unknown) => {
  const cover = unwrapRelation(value);
  if (!cover) return { data: null };
  const attributes = asRecord(cover.attributes) ?? cover;
  return {
    data: {
      id: cover.id,
      attributes: {
        name: attributes.name ?? null,
        url: attributes.url ?? null,
        formats: attributes.formats ?? null,
      },
    },
  };
};

const projectCartItem = (value: unknown) => {
  const item = asRecord(value);
  if (!item) return null;
  const attributes = asRecord(item.attributes) ?? item;
  const variation = unwrapRelation(attributes.product_variation);
  const variationAttributes = variation
    ? (asRecord(variation.attributes) ?? variation)
    : null;
  const product = variationAttributes
    ? unwrapRelation(variationAttributes.product)
    : null;
  const productAttributes = product
    ? (asRecord(product.attributes) ?? product)
    : null;

  return {
    id: item.id,
    attributes: {
      Sum: attributes.Sum ?? "0",
      Count: Number(attributes.Count) || 0,
      product_variation: {
        data: variation
          ? {
              id: variation.id,
              attributes: {
                product: {
                  data: product
                    ? {
                        id: product.id,
                        attributes: {
                          Title: productAttributes?.Title ?? null,
                          CoverImage: projectCoverImage(
                            productAttributes?.CoverImage,
                          ),
                        },
                      }
                    : null,
                },
              },
            }
          : null,
      },
    },
  };
};

export const projectCartReportRow = (value: unknown) => {
  const cart = asRecord(value) ?? {};
  const attributes = asRecord(cart.attributes) ?? cart;
  const user = unwrapRelation(attributes.user);
  const userAttributes = user ? (asRecord(user.attributes) ?? user) : null;
  const userInfo = userAttributes
    ? unwrapRelation(userAttributes.user_info)
    : null;
  const userInfoAttributes = userInfo
    ? (asRecord(userInfo.attributes) ?? userInfo)
    : null;

  return {
    id: cart.id,
    attributes: {
      Status: attributes.Status ?? null,
      createdAt: attributes.createdAt ?? null,
      updatedAt: attributes.updatedAt ?? null,
      user: {
        data: user
          ? {
              id: user.id,
              attributes: {
                Phone:
                  (typeof userAttributes?.phone === "string"
                    ? userAttributes.phone
                    : null) ??
                  (typeof userAttributes?.Phone === "string"
                    ? userAttributes.Phone
                    : null),
                user_info: {
                  data: userInfo
                    ? {
                        id: userInfo.id,
                        attributes: {
                          FirstName: userInfoAttributes?.FirstName ?? null,
                          LastName: userInfoAttributes?.LastName ?? null,
                        },
                      }
                    : null,
                },
              },
            }
          : null,
      },
      cart_items: {
        data: unwrapCollection(attributes.cart_items)
          .map(projectCartItem)
          .filter((item): item is NonNullable<typeof item> => item !== null),
      },
    },
  };
};

export const CART_REPORT_QUERY = {
  select: ["id", "Status", "createdAt", "updatedAt"],
  populate: CART_REPORT_POPULATE,
  orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
};

/**
 * Staff cart list. Query through the documents API and project the REST shape
 * the admin table already reads. Do not use `super.find` / auth-aware
 * sanitize: `report.carts.read` does not include find grants on user /
 * user_info / cart-item, so those relations were stripped for every role that
 * can open the tab except Superadmin.
 */
export const findCartReportHandler = (strapi: Strapi) =>
  async (ctx: CartReportContext) => {
    const where = buildCartReportFilters(ctx.query?.filters);
    const { page, pageSize } = boundedCartReportPagination(ctx.query?.pagination);
    const cartQuery = strapi.query("api::cart.cart");

    const [rows, total] = await Promise.all([
      cartQuery.findMany({
        where,
        ...CART_REPORT_QUERY,
        offset: (page - 1) * pageSize,
        limit: pageSize,
      }),
      cartQuery.count({ where }),
    ]);

    const data = (Array.isArray(rows) ? rows : []).map(projectCartReportRow);
    const body = {
      data,
      meta: { pagination: adminPagination(page, pageSize, Number(total) || 0) },
    };

    ctx.set?.("Cache-Control", "private, no-store");
    ctx.body = body;
    return body;
  };
