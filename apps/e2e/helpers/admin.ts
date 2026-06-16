import { expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  E2E_CATEGORY_SLUG,
  E2E_RUNTIME_CODE_PREFIX,
  E2E_RUNTIME_PREFIX,
} from "../fixtures/storefront";
import { apiDelete, apiGet, apiPost, apiPut, expectApiForbidden, expectApiOk } from "./api";
import type { E2EAuthRole } from "./auth";
import { strapiOrigin } from "./env";

const E2E_SOURCE = "e2e-storefront";

/**
 * Refuse to run destructive runtime-fixture flows against anything that looks
 * like a real environment. The admin CRUD specs create and delete data, so they
 * must only ever hit the ephemeral CI database (or a local dev stack). Both
 * staging (api.staging.infinitycolor.co) and production (api.infinitycolor.co)
 * are covered by the "infinitycolor" needle; the legacy rgbgroup host too.
 */
export function assertNonProductionTarget() {
  const origin = strapiOrigin().toLowerCase();
  const blocked = ["infinitycolor.co", "infinitycolor.org", "rgbgroup"];
  if (blocked.some((needle) => origin.includes(needle))) {
    throw new Error(
      `Refusing to run destructive admin CRUD against "${origin}". ` +
        "These specs target the ephemeral CI/dev backend only — set E2E_API_URL accordingly.",
    );
  }
}

export type RuntimeProductFixture = {
  productId: number;
  productSlug: string;
  productTitle: string;
  variationId: number;
  variationSku: string;
  stockId: number;
};

export type RuntimeOrderFixture = {
  orderId: number;
  initialStatus: "Paying";
};

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function gotoSuperAdmin(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

export async function seededCategoryId(request: APIRequestContext) {
  const response = await apiGet(request, "admin", "/product-categories", {
    "filters[Slug][$eq]": E2E_CATEGORY_SLUG,
  });
  await expectApiOk(response, "find seeded category");
  const payload = (await response.json()) as { data?: Array<{ id: number }> };
  const category = payload.data?.[0];
  if (!category) {
    throw new Error(`seeded category ${E2E_CATEGORY_SLUG} was not found`);
  }
  return category.id;
}

export async function createRuntimeProductFixture(
  request: APIRequestContext,
): Promise<RuntimeProductFixture> {
  const suffix = uniqueSuffix();
  const productTitle = `${E2E_RUNTIME_PREFIX}Product ${suffix}`;
  const productSlug = `${E2E_RUNTIME_PREFIX.toLowerCase()}product-${suffix}`.replace(/_/g, "-");
  const variationSku = `${E2E_RUNTIME_PREFIX}SKU-${suffix}`;
  const categoryId = await seededCategoryId(request);

  const productResponse = await apiPost(request, "admin", "/products", {
    data: {
      Title: productTitle,
      Slug: productSlug,
      Status: "Active",
      ProductType: "Variable",
      product_main_category: categoryId,
      external_source: E2E_SOURCE,
      external_id: productSlug,
    },
  });
  await expectApiOk(productResponse, "create runtime product");
  const productPayload = (await productResponse.json()) as { data?: { id: number } };
  const productId = Number(productPayload.data?.id);
  expect(productId, "created product id").toBeGreaterThan(0);

  const stockResponse = await apiPost(request, "admin", "/product-stocks", {
    data: {
      Count: 12,
      external_source: E2E_SOURCE,
      external_id: `${variationSku}-stock`,
    },
  });
  await expectApiOk(stockResponse, "create runtime product stock");
  const stockPayload = (await stockResponse.json()) as { data?: { id: number } };
  const stockId = Number(stockPayload.data?.id);
  expect(stockId, "created stock id").toBeGreaterThan(0);

  const variationResponse = await apiPost(request, "admin", "/product-variations", {
    data: {
      SKU: variationSku,
      Price: 750000,
      DiscountPrice: 700000,
      IsPublished: true,
      product: productId,
      product_stock: stockId,
      external_source: E2E_SOURCE,
      external_id: variationSku,
    },
  });
  await expectApiOk(variationResponse, "create runtime product variation");
  const variationPayload = (await variationResponse.json()) as { data?: { id: number } };
  const variationId = Number(variationPayload.data?.id);
  expect(variationId, "created variation id").toBeGreaterThan(0);

  return { productId, productSlug, productTitle, variationId, variationSku, stockId };
}

export async function cleanupRuntimeProducts(request: APIRequestContext) {
  const variations = await apiGet(request, "admin", "/product-variations", {
    "filters[external_source][$eq]": E2E_SOURCE,
    "filters[SKU][$startsWith]": E2E_RUNTIME_PREFIX,
    "pagination[pageSize]": 100,
  });
  if (variations.ok()) {
    const payload = (await variations.json()) as { data?: Array<{ id: number }> };
    for (const variation of payload.data ?? []) {
      await apiDelete(request, "admin", `/product-variations/${variation.id}`);
    }
  }

  const products = await apiGet(request, "admin", "/products", {
    "filters[external_source][$eq]": E2E_SOURCE,
    "filters[Title][$startsWith]": E2E_RUNTIME_PREFIX,
    "pagination[pageSize]": 100,
  });
  if (products.ok()) {
    const payload = (await products.json()) as { data?: Array<{ id: number }> };
    for (const product of payload.data ?? []) {
      await apiDelete(request, "admin", `/products/${product.id}`);
    }
  }

  const stocks = await apiGet(request, "admin", "/product-stocks", {
    "filters[external_source][$eq]": E2E_SOURCE,
    "filters[external_id][$contains]": E2E_RUNTIME_PREFIX,
    "pagination[pageSize]": 100,
  });
  if (stocks.ok()) {
    const payload = (await stocks.json()) as { data?: Array<{ id: number }> };
    for (const stock of payload.data ?? []) {
      await apiDelete(request, "admin", `/product-stocks/${stock.id}`);
    }
  }
}

export async function updateRuntimeVariationStock(
  request: APIRequestContext,
  stockId: number,
  count: number,
) {
  const response = await apiPut(request, "admin", `/product-stocks/${stockId}`, {
    data: { Count: count },
  });
  await expectApiOk(response, `update stock ${stockId}`);
}

export async function updateOrderStatus(
  request: APIRequestContext,
  orderId: number,
  status: "Paying" | "Started" | "Shipment" | "Done" | "Returned" | "Cancelled",
) {
  const response = await apiPut(request, "admin", `/orders/${orderId}`, {
    data: { Status: status },
  });
  await expectApiOk(response, `update order ${orderId}`);
}

export async function createRuntimeOrder(request: APIRequestContext): Promise<RuntimeOrderFixture> {
  const response = await apiPost(request, "admin", "/orders", {
    data: {
      Date: new Date().toISOString(),
      Status: "Paying",
      Type: "Manual",
      Description: `${E2E_RUNTIME_PREFIX}manual order`,
      external_source: E2E_SOURCE,
      external_id: `${E2E_RUNTIME_PREFIX}order-${uniqueSuffix()}`,
    },
  });
  await expectApiOk(response, "create runtime order");
  const payload = (await response.json()) as { data?: { id: number } };
  const orderId = Number(payload.data?.id);
  expect(orderId, "created order id").toBeGreaterThan(0);
  return { orderId, initialStatus: "Paying" };
}

export async function cleanupRuntimeOrders(request: APIRequestContext) {
  const response = await apiGet(request, "admin", "/orders", {
    "filters[external_source][$eq]": E2E_SOURCE,
    "filters[Description][$startsWith]": E2E_RUNTIME_PREFIX,
    "pagination[pageSize]": 100,
  });
  if (!response.ok()) return;
  const payload = (await response.json()) as { data?: Array<{ id: number }> };
  for (const order of payload.data ?? []) {
    await apiDelete(request, "admin", `/orders/${order.id}`);
  }
}

// ---------------------------------------------------------------------------
// Shipping methods
// Shipping has no external_source column, so runtime rows are tracked by the
// E2E_DO_NOT_USE_ Title prefix (Code carries the slug-safe prefix variant).
// ---------------------------------------------------------------------------

export type RuntimeShippingFixture = {
  shippingId: number;
  title: string;
  code: string;
};

export async function createRuntimeShipping(
  request: APIRequestContext,
  opts: { withRule?: boolean } = {},
): Promise<RuntimeShippingFixture> {
  const suffix = uniqueSuffix();
  const title = `${E2E_RUNTIME_PREFIX}Shipping ${suffix}`;
  const code = `${E2E_RUNTIME_CODE_PREFIX}ship-${suffix}`.toLowerCase();
  const data: Record<string, unknown> = {
    Title: title,
    Code: code,
    Price: 45000,
    SortOrder: 0,
    IsActive: true,
  };
  if (opts.withRule) {
    // A single free-shipping-over-threshold rule, the lowest-risk dynamic rule shape.
    data.Rules = [
      {
        title: `${E2E_RUNTIME_PREFIX}rule`,
        active: true,
        priority: 1,
        price: 0,
        freeShippingThreshold: 1_000_000,
        minSubtotal: null,
        maxSubtotal: null,
        minQuantity: null,
        maxQuantity: null,
        minWeight: null,
        maxWeight: null,
        provinceIds: [],
        cityIds: [],
        excludedProvinceIds: [],
        excludedCityIds: [],
        productIds: [],
        categoryIds: [],
        roleTypes: [],
      },
    ];
  }
  const response = await apiPost(request, "admin", "/shippings", { data });
  await expectApiOk(response, "create runtime shipping");
  const payload = (await response.json()) as { data?: { id: number } };
  const shippingId = Number(payload.data?.id);
  expect(shippingId, "created shipping id").toBeGreaterThan(0);
  return { shippingId, title, code };
}

export async function cleanupRuntimeShipping(request: APIRequestContext) {
  const response = await apiGet(request, "admin", "/shippings", {
    "filters[Title][$startsWith]": E2E_RUNTIME_PREFIX,
    "pagination[pageSize]": 100,
  });
  if (!response.ok()) return;
  const payload = (await response.json()) as { data?: Array<{ id: number }> };
  for (const item of payload.data ?? []) {
    await apiDelete(request, "admin", `/shippings/${item.id}`);
  }
}

// ---------------------------------------------------------------------------
// Coupons (discount codes). Tracked by the slug-safe Code prefix.
// ---------------------------------------------------------------------------

export type RuntimeCouponFixture = {
  couponId: number;
  code: string;
};

export async function createRuntimeCoupon(
  request: APIRequestContext,
  overrides: { type?: "Discount" | "Cash"; amount?: number } = {},
): Promise<RuntimeCouponFixture> {
  const suffix = uniqueSuffix();
  const code = `${E2E_RUNTIME_CODE_PREFIX}coupon-${suffix}`.toLowerCase();
  const now = Date.now();
  const data = {
    Code: code,
    Type: overrides.type ?? "Discount",
    Amount: overrides.amount ?? 15,
    IsActive: true,
    StartDate: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    EndDate: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
    LimitUsage: 100,
  };
  const response = await apiPost(request, "admin", "/discounts", { data });
  await expectApiOk(response, "create runtime coupon");
  const payload = (await response.json()) as { data?: { id: number } };
  const couponId = Number(payload.data?.id);
  expect(couponId, "created coupon id").toBeGreaterThan(0);
  return { couponId, code };
}

export async function cleanupRuntimeCoupons(request: APIRequestContext) {
  const response = await apiGet(request, "admin", "/discounts", {
    "filters[Code][$startsWith]": E2E_RUNTIME_CODE_PREFIX,
    "pagination[pageSize]": 100,
  });
  if (!response.ok()) return;
  const payload = (await response.json()) as { data?: Array<{ id: number }> };
  for (const item of payload.data ?? []) {
    await apiDelete(request, "admin", `/discounts/${item.id}`);
  }
}

export async function expectForbiddenForRole(
  request: APIRequestContext,
  role: E2EAuthRole,
  method: "get" | "post" | "put" | "delete",
  pathname: string,
  data?: unknown,
) {
  const response =
    method === "get"
      ? await apiGet(request, role, pathname)
      : method === "post"
        ? await apiPost(request, role, pathname, data)
        : method === "put"
          ? await apiPut(request, role, pathname, data)
          : await apiDelete(request, role, pathname);
  await expectApiForbidden(response);
}
