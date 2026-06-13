import { readFileSync } from "node:fs";
import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import { authStorageStatePath, type E2EAuthRole } from "./auth";
import { strapiApiURL } from "./env";
import { E2E_PAYMENT_VARIATION_SKU, E2E_PRODUCT_SLUG } from "../fixtures/storefront";

/**
 * Read the bearer token a role's storage state carries in localStorage. The
 * states are produced by global-setup; this lets API-level assertions reuse the
 * exact same identity the browser uses, without a second login round-trip.
 */
export function authTokenForRole(role: E2EAuthRole): string {
  const raw = JSON.parse(readFileSync(authStorageStatePath(role), "utf8")) as {
    origins?: { localStorage?: { name: string; value: string }[] }[];
  };
  const token = raw.origins?.[0]?.localStorage?.find((e) => e.name === "accessToken")?.value;
  if (!token) {
    throw new Error(`No accessToken found in auth storage state for role "${role}"`);
  }
  return token;
}

export function authHeaders(role: E2EAuthRole): Record<string, string> {
  return {
    Authorization: `Bearer ${authTokenForRole(role)}`,
    Accept: "application/json",
  };
}

function apiUrl(pathname: string): string {
  const base = strapiApiURL().replace(/\/$/, "");
  return pathname.startsWith("/") ? `${base}${pathname}` : `${base}/${pathname}`;
}

/** Authenticated GET against the Strapi API as the given role. */
export function apiGet(
  request: APIRequestContext,
  role: E2EAuthRole,
  pathname: string,
  params?: Record<string, string | number | boolean>,
) {
  return request.get(apiUrl(pathname), { headers: authHeaders(role), params });
}

/** Authenticated POST/PUT/DELETE helpers as the given role. */
export function apiPost(
  request: APIRequestContext,
  role: E2EAuthRole,
  pathname: string,
  data?: unknown,
) {
  return request.post(apiUrl(pathname), { headers: authHeaders(role), data });
}

export function apiPut(
  request: APIRequestContext,
  role: E2EAuthRole,
  pathname: string,
  data?: unknown,
) {
  return request.put(apiUrl(pathname), { headers: authHeaders(role), data });
}

export function apiDelete(request: APIRequestContext, role: E2EAuthRole, pathname: string) {
  return request.delete(apiUrl(pathname), { headers: authHeaders(role) });
}

/**
 * Assert that an operation is rejected by the backend for a role. Accepts 401 or
 * 403 (Strapi returns either depending on the policy that blocks the request),
 * and fails clearly if the operation unexpectedly succeeds.
 */
export async function expectApiForbidden(
  response: APIResponse,
) {
  expect(
    [401, 403],
    `expected backend to reject the request but got ${response.status()}`,
  ).toContain(response.status());
}

/** Fetch an order's payment/status snapshot for backend-state assertions. */
export async function getOrderStatus(
  request: APIRequestContext,
  role: E2EAuthRole,
  orderId: number,
) {
  const response = await apiGet(request, role, `/orders/${orderId}`);
  expect(response.ok(), `failed to read order ${orderId}: ${response.status()}`).toBeTruthy();
  return response.json();
}

type StrapiCollection<T> = { data?: Array<{ id: number; attributes?: T } & T> };
type StrapiEntity<T> = { data?: ({ id: number; attributes?: T } & T) | null };

export async function expectApiOk(response: APIResponse, label: string) {
  expect(response.ok(), `${label} failed with ${response.status()}: ${await response.text()}`).toBe(
    true,
  );
}

export async function findSeededProduct(request: APIRequestContext, role: E2EAuthRole = "admin") {
  const response = await apiGet(request, role, "/products", {
    "filters[Slug][$eq]": E2E_PRODUCT_SLUG,
    "populate[0]": "product_variations",
    "populate[1]": "product_main_category",
  });
  await expectApiOk(response, "find seeded product");
  const payload = (await response.json()) as StrapiCollection<Record<string, unknown>>;
  const product = payload.data?.[0];
  if (!product) {
    throw new Error(`seeded product ${E2E_PRODUCT_SLUG} was not found`);
  }
  return product;
}

export async function findProductVariationBySku(
  request: APIRequestContext,
  sku = E2E_PAYMENT_VARIATION_SKU,
  role: E2EAuthRole = "admin",
) {
  const response = await apiGet(request, role, "/product-variations", {
    "filters[SKU][$eq]": sku,
    "populate[0]": "product_stock",
    "populate[1]": "product",
  });
  await expectApiOk(response, `find product variation ${sku}`);
  const payload = (await response.json()) as StrapiCollection<{
    SKU?: string;
    product_stock?: { data?: { id: number; attributes?: { Count?: number } } };
  }>;
  const variation = payload.data?.[0];
  if (!variation) {
    throw new Error(`product variation ${sku} was not found`);
  }
  return variation;
}

export async function getProductVariationStock(
  request: APIRequestContext,
  variationId: number,
  role: E2EAuthRole = "admin",
) {
  const response = await apiGet(request, role, `/product-variations/${variationId}`, {
    "populate[0]": "product_stock",
  });
  await expectApiOk(response, `read product variation ${variationId}`);
  const payload = (await response.json()) as StrapiEntity<{
    product_stock?: { data?: { attributes?: { Count?: number } } };
  }>;
  return Number(payload.data?.attributes?.product_stock?.data?.attributes?.Count ?? 0);
}

export async function getCart(request: APIRequestContext, role: E2EAuthRole = "customer") {
  const response = await apiGet(request, role, "/carts/me");
  await expectApiOk(response, `read ${role} cart`);
  return response.json() as Promise<{
    data?: {
      id: number;
      cart_items?: Array<{
        id: number;
        Count: number;
        product_variation?: { id?: number };
      }>;
    };
  }>;
}

export async function clearCart(request: APIRequestContext, role: E2EAuthRole = "customer") {
  const cart = await getCart(request, role);
  const items = cart.data?.cart_items ?? [];
  for (const item of items) {
    const response = await apiDelete(request, role, `/carts/remove-item/${item.id}`);
    await expectApiOk(response, `remove cart item ${item.id}`);
  }
}

export async function resetCartToVariation(
  request: APIRequestContext,
  variationId: number,
  count = 1,
  role: E2EAuthRole = "customer",
) {
  await clearCart(request, role);
  const response = await apiPost(request, role, "/carts/add-item", {
    productVariationId: variationId,
    count,
  });
  await expectApiOk(response, `add variation ${variationId} to cart`);
}

export async function getPaymentStatus(
  request: APIRequestContext,
  role: E2EAuthRole,
  orderId: number,
) {
  const response = await apiGet(request, role, `/orders/${orderId}/payment-status`);
  await expectApiOk(response, `read payment status for order ${orderId}`);
  const payload = (await response.json()) as {
    data?: {
      success?: boolean;
      orderId?: number;
      status?: string;
      isPaid?: boolean;
      transactionId?: string | number | null;
      paymentGateway?: string | null;
    };
  };
  return payload.data;
}
