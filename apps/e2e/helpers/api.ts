import { readFileSync } from "node:fs";
import { expect, type APIRequestContext, type APIResponse } from "@playwright/test";
import { authStorageStatePath, type E2EAuthRole } from "./auth";
import { centralAuthOrigin, storefrontBaseURL, strapiApiURL } from "./env";
import { E2E_PAYMENT_VARIATION_SKU, E2E_PRODUCT_SLUG } from "../fixtures/storefront";

type CachedRoleToken = { token: string; refreshAfter: number };
const cachedRoleTokens = new Map<E2EAuthRole, CachedRoleToken>();
const pendingRoleTokens = new Map<E2EAuthRole, Promise<string>>();

function jwtExpiry(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof parsed.exp === "number" ? parsed.exp * 1_000 : 0;
  } catch {
    return 0;
  }
}

function sessionCookieForRole(role: E2EAuthRole): string {
  const raw = JSON.parse(readFileSync(authStorageStatePath(role), "utf8")) as {
    cookies?: Array<{ name: string; value: string; domain: string }>;
  };
  const authHost = new URL(centralAuthOrigin()).hostname;
  const cookies = (raw.cookies ?? []).filter(
    (cookie) =>
      cookie.domain.replace(/^\./, "") === authHost &&
      cookie.name.endsWith("session_token"),
  );
  if (cookies.length !== 1) {
    throw new Error(`Expected one Better Auth session cookie for role "${role}"`);
  }
  return `${cookies[0].name}=${cookies[0].value}`;
}

export async function authTokenForRole(role: E2EAuthRole): Promise<string> {
  const cached = cachedRoleTokens.get(role);
  if (cached && cached.refreshAfter > Date.now()) return cached.token;
  const pending = pendingRoleTokens.get(role);
  if (pending) return pending;

  const acquisition = (async () => {
    const response = await fetch(
      `${centralAuthOrigin().replace(/\/$/, "")}/api/auth/token`,
      {
        headers: {
          Accept: "application/json",
          Cookie: sessionCookieForRole(role),
          Origin: new URL(storefrontBaseURL()).origin,
        },
        cache: "no-store",
      },
    );
    if (!response.ok) {
      throw new Error(
        `Better Auth token acquisition failed for role "${role}" (${response.status})`,
      );
    }
    const payload = (await response.json()) as { token?: string };
    if (!payload.token) throw new Error(`Better Auth omitted token for role "${role}"`);
    const expiry = jwtExpiry(payload.token);
    if (expiry <= Date.now()) throw new Error(`Better Auth returned an expired token for "${role}"`);
    cachedRoleTokens.set(role, {
      token: payload.token,
      refreshAfter: Math.max(Date.now(), expiry - 10_000),
    });
    return payload.token;
  })().finally(() => pendingRoleTokens.delete(role));
  pendingRoleTokens.set(role, acquisition);
  return acquisition;
}

export async function authHeaders(role: E2EAuthRole): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${await authTokenForRole(role)}`,
    Accept: "application/json",
  };
}

function apiUrl(pathname: string): string {
  const base = strapiApiURL().replace(/\/$/, "");
  return pathname.startsWith("/") ? `${base}${pathname}` : `${base}/${pathname}`;
}

/** Authenticated GET against the Strapi API as the given role. */
export async function apiGet(
  request: APIRequestContext,
  role: E2EAuthRole,
  pathname: string,
  params?: Record<string, string | number | boolean>,
) {
  return request.get(apiUrl(pathname), { headers: await authHeaders(role), params });
}

/** Authenticated POST/PUT/DELETE helpers as the given role. */
export async function apiPost(
  request: APIRequestContext,
  role: E2EAuthRole,
  pathname: string,
  data?: unknown,
) {
  return request.post(apiUrl(pathname), { headers: await authHeaders(role), data });
}

export async function apiPut(
  request: APIRequestContext,
  role: E2EAuthRole,
  pathname: string,
  data?: unknown,
) {
  return request.put(apiUrl(pathname), { headers: await authHeaders(role), data });
}

export async function apiDelete(request: APIRequestContext, role: E2EAuthRole, pathname: string) {
  return request.delete(apiUrl(pathname), { headers: await authHeaders(role) });
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

export async function getWalletBalance(
  request: APIRequestContext,
  role: E2EAuthRole = "customer",
) {
  const response = await apiGet(request, role, "/local-user-wallet/me");
  await expectApiOk(response, `read ${role} wallet`);
  const payload = (await response.json()) as {
    success?: boolean;
    data?: { balance?: number | string };
  };
  expect(payload.success, `${role} wallet response should be successful`).toBe(true);
  return Number(payload.data?.balance ?? 0);
}

/**
 * The full wallet picture, not just the posted balance.
 *
 * Available is what the shopper can actually spend: money committed to a live
 * checkout of theirs is held and is not offered. Asserting on `balance` alone
 * would pass while the storefront advertised held credit as spendable.
 */
export async function getWalletAvailability(
  request: APIRequestContext,
  role: E2EAuthRole = "customer",
) {
  const response = await apiGet(request, role, "/local-user-wallet/me");
  await expectApiOk(response, `read ${role} wallet availability`);
  const payload = (await response.json()) as {
    success?: boolean;
    data?: {
      balance?: number | string;
      heldBalance?: number | string;
      availableBalance?: number | string;
      reusableBalance?: number | string;
    };
  };
  expect(payload.success, `${role} wallet response should be successful`).toBe(true);
  const balanceIrr = Number(payload.data?.balance ?? 0);
  const heldIrr = Number(payload.data?.heldBalance ?? 0);
  return {
    balanceIrr,
    heldIrr,
    availableIrr: Number(payload.data?.availableBalance ?? Math.max(0, balanceIrr - heldIrr)),
    reusableIrr: Number(payload.data?.reusableBalance ?? 0),
  };
}

/** What the store will accept for a top-up right now. Answered even when off. */
export async function getTopupOptions(
  request: APIRequestContext,
  role: E2EAuthRole = "customer",
) {
  const response = await apiGet(request, role, "/wallet/topup-options");
  await expectApiOk(response, "read wallet top-up options");
  const payload = (await response.json()) as {
    data?: {
      enabled?: boolean;
      gateways?: Array<{ code: string; title: string }>;
      minToman?: number;
      maxToman?: number;
    };
  };
  return payload.data ?? {};
}

/** One customer-visible top-up, by the reference the store minted for it. */
export async function getTopupStatus(
  request: APIRequestContext,
  saleOrderId: string,
  role: E2EAuthRole = "customer",
) {
  const response = await apiGet(
    request,
    role,
    `/wallet/topups/${encodeURIComponent(saleOrderId)}`,
  );
  await expectApiOk(response, `read top-up ${saleOrderId}`);
  const payload = (await response.json()) as {
    data?: { topup?: Record<string, unknown> } & Record<string, unknown>;
  };
  return (payload.data?.topup ?? payload.data ?? {}) as {
    status?: string;
    amountToman?: number;
    gateway?: string;
    reference?: string | null;
  };
}

/**
 * Every wallet ledger row for this customer, newest first.
 *
 * Counting rows is how "credited exactly once" is asserted: a balance that
 * happens to be right can still have been reached by two credits and a debit.
 */
export async function getWalletTransactions(
  request: APIRequestContext,
  role: E2EAuthRole = "customer",
) {
  const response = await apiGet(
    request,
    role,
    "/local-user-wallet-transactions?sort[0]=id:desc&pagination[pageSize]=100",
  );
  await expectApiOk(response, `read ${role} wallet ledger`);
  const payload = (await response.json()) as {
    data?: Array<{ id?: number; attributes?: Record<string, unknown> } & Record<string, unknown>>;
  };
  return (payload.data ?? []).map((row) => ({
    id: Number(row.id),
    ...(row.attributes ?? row),
  })) as Array<{ id: number; Type?: string; Amount?: number | string; ReferenceId?: string }>;
}

export async function getCustomerOrderDetail(
  request: APIRequestContext,
  orderId: number,
  role: E2EAuthRole = "customer",
) {
  const response = await apiGet(request, role, `/orders/my-orders/${orderId}`);
  await expectApiOk(response, `read customer order ${orderId}`);
  const payload = (await response.json()) as {
    data?: {
      id?: number;
      Status?: string;
      order_items?: Array<{
        ProductTitle?: string;
        ProductSKU?: string;
        PerAmount?: number | string;
        Count?: number;
      }>;
      contract_transactions?: Array<{
        Type?: string;
        Status?: string;
        external_source?: string | null;
      }>;
    };
  };
  return payload.data;
}
