import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_CATEGORY_SLUG, E2E_RUNTIME_PREFIX } from "../fixtures/storefront";
import { apiDelete, apiGet, apiPost, apiPut, expectApiForbidden, expectApiOk } from "./api";
import type { E2EAuthRole } from "./auth";

const E2E_SOURCE = "e2e-storefront";

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
