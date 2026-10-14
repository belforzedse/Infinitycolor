import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import {
  E2E_CATEGORY_SLUG,
  E2E_RUNTIME_CODE_PREFIX,
  E2E_RUNTIME_PREFIX,
} from "../fixtures/storefront";
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPut,
  authHeaders,
  expectApiForbidden,
  expectApiOk,
} from "./api";
import type { E2EAuthRole } from "./auth";
import { strapiApiURL, strapiOrigin } from "./env";

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

export type RuntimeProductFixtureOptions = {
  initialPublication?: "Active" | "InActive";
};

export type RuntimeOrderFixture = {
  orderId: number;
  initialStatus: "Started";
};

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type CatalogFixtureWrite = (method: "post" | "put", pathname: string, data: unknown, extraHeaders?: Record<string, string>) => Promise<APIResponse>;

async function withRuntimeProductLease<T>(request: APIRequestContext, productId: number, operation: (write: CatalogFixtureWrite) => Promise<T>): Promise<T> {
  assertNonProductionTarget();
  const base = strapiApiURL().replace(/\/$/, "");
  const acquired = await request.post(`${base}/products/${productId}/edit-lease/acquire`, {
    headers: await authHeaders("admin"), data: { editorInstanceId: randomUUID() },
  });
  expect(acquired.ok(), `acquire fixture product ${productId}: HTTP ${acquired.status()}`).toBe(true);
  const { data: { lease, snapshot } } = await acquired.json() as { data: { lease: { token: string; editorInstanceId: string; generation: number }; snapshot: { revision: number } } };
  let revision = snapshot.revision;
  const proofHeaders = {
    "X-Product-Edit-Token": lease.token,
    "X-Product-Edit-Instance": lease.editorInstanceId,
    "X-Product-Edit-Generation": String(lease.generation),
  };
  const write: CatalogFixtureWrite = async (method, pathname, data, extraHeaders = {}) => {
    const response = await request[method](`${base}${pathname}`, {
      headers: { ...(await authHeaders("admin")), ...proofHeaders, "X-Product-Expected-Revision": String(revision), ...extraHeaders }, data,
    });
    await expectApiOk(response, `fixture catalog ${method} ${pathname}`);
    const payload = await response.json() as { meta?: { editRevision?: number } };
    expect(Number.isSafeInteger(payload.meta?.editRevision), "committed fixture product revision").toBe(true);
    revision = payload.meta!.editRevision!;
    return response;
  };
  try {
    return await operation(write);
  } finally {
    const released = await request.post(`${base}/products/${productId}/edit-lease/release`, {
      headers: { ...(await authHeaders("admin")), ...proofHeaders }, data: {},
    });
    await expectApiOk(released, `release fixture product ${productId}`);
  }
}

export async function publishRuntimeProduct(request: APIRequestContext, productId: number, command: { action: string; publishAt?: string; timezone?: string }) {
  return withRuntimeProductLease(request, productId, (write) => write("post", `/products/${productId}/publication`, command));
}

export async function gotoSuperAdmin(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(
    new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
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
  options: RuntimeProductFixtureOptions = {},
): Promise<RuntimeProductFixture> {
  assertNonProductionTarget();
  const suffix = uniqueSuffix();
  const productTitle = `${E2E_RUNTIME_PREFIX}Product ${suffix}`;
  const productSlug =
    `${E2E_RUNTIME_PREFIX.toLowerCase()}product-${suffix}`.replace(/_/g, "-");
  const variationSku = `${E2E_RUNTIME_PREFIX}SKU-${suffix}`;
  const categoryId = await seededCategoryId(request);

  const productResponse = await apiPost(request, "admin", "/products", {
    data: {
      Title: productTitle,
      Slug: productSlug,
      ProductType: "Variable",
      product_main_category: categoryId,
      external_source: E2E_SOURCE,
      external_id: productSlug,
    },
  });
  await expectApiOk(productResponse, "create runtime product");
  const productPayload = (await productResponse.json()) as {
    data?: { id: number };
  };
  const productId = Number(productPayload.data?.id);
  expect(productId, "created product id").toBeGreaterThan(0);

  const { variationId, stockId } = await withRuntimeProductLease(request, productId, async (write) => {
    const variationResponse = await write("post", "/product-variations", {
      data: {
        SKU: variationSku,
        Price: 750000,
        DiscountPrice: 700000,
        IsPublished: true,
        product: productId,
        external_source: E2E_SOURCE,
        external_id: variationSku,
      },
    });
    const variationPayload = await variationResponse.json() as { data: { id: number } };
    const variationId = Number(variationPayload.data.id);
    expect(variationId, "created variation id").toBeGreaterThan(0);
    // Variation creation initializes its one stock row. Update that row under
    // the lease and its own stock revision rather than creating another one.
    const stockResponse = await apiGet(request, "admin", "/product-stocks", {
      "filters[product_variation][id][$eq]": variationId,
    });
    await expectApiOk(stockResponse, "read initialized fixture stock");
    const stockPayload = await stockResponse.json() as { data: Array<{ id: number; attributes: { StockRevision: number } }> };
    expect(stockPayload.data, "one initialized fixture stock").toHaveLength(1);
    const stockId = Number(stockPayload.data[0].id);
    const stockRevision = stockPayload.data[0].attributes.StockRevision;
    expect(stockId, "initialized stock id").toBeGreaterThan(0);
    expect(Number.isSafeInteger(stockRevision), "initialized stock revision").toBe(true);
    await write("put", `/product-stocks/${stockId}`, { data: { Count: 12 } }, { "X-Product-Expected-Stock-Revision": String(stockRevision) });
    if ((options.initialPublication ?? "Active") === "Active") await write("post", `/products/${productId}/publication`, { action: "publish-now" });
    return { variationId, stockId };
  });

  return {
    productId,
    productSlug,
    productTitle,
    variationId,
    variationSku,
    stockId,
  };
}

export async function cleanupRuntimeProducts(request: APIRequestContext) {
  assertNonProductionTarget();
  const products = await apiGet(request, "admin", "/products", {
    "filters[external_source][$eq]": E2E_SOURCE,
    "filters[Title][$startsWith]": E2E_RUNTIME_PREFIX,
    "pagination[pageSize]": 100,
  });
  await expectApiOk(products, "find fixture products for cleanup");
  const payload = (await products.json()) as { data?: Array<{ id: number }> };
  for (const product of payload.data ?? []) {
    // The canonical lifecycle retires owned children and preserves tombstones.
    await expectApiOk(await apiPost(request, "admin", `/products/${product.id}/soft-delete`, {}), "trash fixture product");
    await expectApiOk(await apiPost(request, "admin", `/products/${product.id}/permanent-delete`, {}), "purge fixture product");
  }
  const remaining = await apiGet(request, "admin", "/products", { "filters[external_source][$eq]": E2E_SOURCE, "filters[Title][$startsWith]": E2E_RUNTIME_PREFIX });
  await expectApiOk(remaining, "verify fixture product cleanup");
  expect((await remaining.json()).data).toHaveLength(0);
}

export async function updateRuntimeVariationStock(
  request: APIRequestContext,
  stockId: number,
  count: number,
) {
  const response = await apiGet(request, "admin", `/product-stocks/${stockId}`, { "populate[product_variation][populate][product]": "true" });
  await expectApiOk(response, `read stock ${stockId}`);
  const { data } = await response.json();
  const attributes = data.attributes ?? data;
  const variation = attributes.product_variation.data;
  const productId = Number((variation.attributes ?? variation).product.data.id);
  expect(productId, "stock fixture product owner").toBeGreaterThan(0);
  expect(Number.isSafeInteger(Number(attributes.StockRevision)), "stock fixture revision").toBe(true);
  await withRuntimeProductLease(request, productId, (write) => write("put", `/product-stocks/${stockId}`, { data: { Count: count } }, { "X-Product-Expected-Stock-Revision": String(attributes.StockRevision) }));
}

/**
 * One step of the fulfilment chain, which runs Started -> Done («تکمیل شده») ->
 * Shipment («ارسال»). Transitions that skip a step are refused with
 * INVALID_ORDER_TRANSITION, so callers must walk it in order.
 */
export async function updateOrderStatus(
  request: APIRequestContext,
  orderId: number,
  status: "Shipment" | "Done",
) {
  const response = await apiPost(
    request,
    "admin",
    `/orders/${orderId}/admin/transition`,
    {
      status,
    },
  );
  await expectApiOk(response, `transition order ${orderId} to ${status}`);
}

export async function createRuntimeOrder(
  request: APIRequestContext,
): Promise<RuntimeOrderFixture> {
  const response = await apiPost(request, "admin", "/orders", {
    data: {
      Date: new Date().toISOString(),
      Status: "Started",
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
  return { orderId, initialStatus: "Started" };
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

export type RuntimeStoryFixture = {
  storyId: number;
  title: string;
};

export async function createRuntimeStory(
  request: APIRequestContext,
  role: E2EAuthRole = "seller-2",
): Promise<RuntimeStoryFixture> {
  const suffix = uniqueSuffix();
  const title = `${E2E_RUNTIME_PREFIX}Story ${suffix}`;
  // Every story item needs its media; upload it as the role, as the admin UI does.
  const upload = await request.post(`${strapiApiURL().replace(/\/$/, "")}/upload`, {
    headers: await authHeaders(role),
    multipart: {
      files: {
        name: `${E2E_RUNTIME_PREFIX}story-${suffix}.png`,
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      },
    },
  });
  await expectApiOk(upload, `upload runtime story media as ${role}`);
  const mediaId = Number(((await upload.json()) as Array<{ id?: number }>)[0]?.id);
  expect(mediaId, "uploaded story media id").toBeGreaterThan(0);
  const response = await apiPost(request, role, "/stories", {
    data: {
      Title: title,
      MediaType: "image",
      Media: mediaId,
      IsActive: false,
      SortOrder: 0,
    },
  });
  await expectApiOk(response, `create runtime story as ${role}`);
  const payload = (await response.json()) as { data?: { id?: number } };
  const storyId = Number(payload.data?.id);
  expect(storyId, "created story id").toBeGreaterThan(0);
  return { storyId, title };
}

export async function cleanupRuntimeStories(request: APIRequestContext) {
  const response = await apiGet(request, "admin", "/stories", {
    "filters[Title][$startsWith]": E2E_RUNTIME_PREFIX,
    "pagination[pageSize]": 100,
  });
  if (!response.ok()) return;
  const payload = (await response.json()) as { data?: Array<{ id: number }> };
  for (const item of payload.data ?? []) {
    await apiDelete(request, "admin", `/stories/${item.id}`);
  }
  const uploads = await apiGet(request, "admin", "/upload/files", {
    "filters[name][$startsWith]": `${E2E_RUNTIME_PREFIX}story-`,
  });
  const files: unknown = uploads.ok() ? await uploads.json() : [];
  for (const file of Array.isArray(files) ? (files as Array<{ id: number }>) : []) {
    await apiDelete(request, "admin", `/upload/files/${file.id}`);
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
