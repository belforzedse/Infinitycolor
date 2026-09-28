import { randomUUID } from "node:crypto";
import { test as base, expect, type Locator, type Page } from "@playwright/test";

/**
 * Fixtures for the staging suite (staging.playwright.config.ts).
 *
 * Test data comes from the backend's env-gated fixture API
 * (apps/backend/src/api/e2e-fixture): each worker owns a slot, which is one
 * shopper and one product of its own, reset at the start of every test. The
 * fixture credential travels through Node's fetch, never through a Playwright
 * request context, so it cannot end up in a trace.
 */

const trimSlash = (value: string) => value.replace(/\/+$/, "");

export const stagingTargets = () => ({
  storefront: trimSlash(process.env.E2E_BASE_URL?.trim() || "https://staging.infinitycolor.co"),
  api: trimSlash(process.env.E2E_API_URL?.trim() || "https://api.staging.infinitycolor.co/api"),
  auth: trimSlash(process.env.E2E_AUTH_ORIGIN?.trim() || "https://auth.staging.infinitycolor.co"),
});

export type FixtureVariation = {
  id: number;
  sku: string;
  priceToman: number;
  color: string;
  size: string;
};

export type Shopper = {
  slot: number;
  userId: number;
  phone: string;
  password: string;
  firstName: string;
  lastName: string;
  product: { id: number; slug: string; title: string; categorySlug: string };
  variations: { inStock: FixtureVariation; outOfStock: FixtureVariation };
  address: { id: number; fullAddress: string; city: string; postalCode: string };
  walletToman: number;
  checks: { gateways: string[] };
  warnings: string[];
};

export type SlotStock = Record<string, { count: number; reserved: number }>;

/**
 * How the suite proves itself to the fixture API: the job's GitLab ID token in
 * CI (`id_tokens:` in .gitlab/ci/staging-release.yml), or a static token set on
 * a laptop.
 */
export type FixtureCredential = {
  kind: "GitLab ID token" | "static token";
  header: "x-e2e-fixtures-id-token" | "x-e2e-fixtures-token";
  value: string;
};

export function fixtureCredential(): FixtureCredential | null {
  const idToken = process.env.E2E_FIXTURES_ID_TOKEN?.trim();
  if (idToken) return { kind: "GitLab ID token", header: "x-e2e-fixtures-id-token", value: idToken };
  const token = process.env.E2E_FIXTURES_TOKEN?.trim();
  if (token) return { kind: "static token", header: "x-e2e-fixtures-token", value: token };
  return null;
}

export const FIXTURE_SETUP_HINT =
  "CI jobs use their GitLab ID token (id_tokens: E2E_FIXTURES_ID_TOKEN); from a laptop, set E2E_FIXTURES_TOKEN " +
  "to staging's static token (deploy/infinity-staging/enable-e2e-fixtures.sh).";

/** A bare 404 (no E2E_FIXTURE code in the body) is the API refusing the caller. */
export const fixtureRefusedMessage = (apiUrl: string, status: number) =>
  `The fixture API at ${apiUrl} refused the request (${status}): fixtures are not enabled there, the static ` +
  `token is wrong, or the backend refused the ID token (its log says why: "[e2e-fixture] refused a GitLab ID ` +
  `token: <claim>"). ${FIXTURE_SETUP_HINT}`;

export class FixtureApi {
  constructor(
    private readonly apiUrl: string,
    private readonly credential: FixtureCredential,
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.apiUrl}/e2e-fixtures${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        [this.credential.header]: this.credential.value,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (response.status === 404 && !text.includes("E2E_FIXTURE")) {
      throw new Error(fixtureRefusedMessage(this.apiUrl, response.status));
    }
    if (!response.ok) {
      throw new Error(`fixture API ${method} ${path} failed (${response.status}): ${text.slice(0, 500)}`);
    }
    return (JSON.parse(text) as { data: T }).data;
  }

  provision(slot: number, walletToman: number) {
    return this.call<Shopper>("POST", "/shoppers", { slot, walletToman });
  }

  stock(slot: number) {
    return this.call<SlotStock>("GET", `/shoppers/${slot}/stock`);
  }

  cleanup(slot: number) {
    return this.call<unknown>("POST", `/shoppers/${slot}/cleanup`);
  }

  setProductPublished(slot: number, published: boolean) {
    return this.call<{ published: boolean }>("POST", `/shoppers/${slot}/product`, { published });
  }
}

// Real-money gateways. A staging run must never reach one; ZarinPal's sandbox
// (sandbox.zarinpal.com) is the only provider page a test may open.
const LIVE_GATEWAY_PATTERN =
  /^https?:\/\/(?:[^/?#]*\.)?(?:payment\.zarinpal\.com|www\.zarinpal\.com|shaparak\.ir|snapppay\.ir|snapppay\.com)(?:[/?#:]|$)/i;
// Analytics and error reporting from test traffic would pollute staging dashboards.
const THIRD_PARTY_PATTERN =
  /^https?:\/\/[^/?#]*(?:analytics\.alpagency|umami|googletagmanager|google-analytics|sentry|clarity|facebook|doubleclick)[^/?#]*(?:[/?#]|$)/i;

type TestFixtures = {
  walletToman: number;
  shopper: Shopper;
  pageErrors: string[];
  stagingGuards: void;
};

type WorkerFixtures = {
  fixtureApi: FixtureApi;
  slot: number;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  fixtureApi: [
    async ({}, use) => {
      const credential = fixtureCredential();
      if (!credential) throw new Error(`No fixture API credential. ${FIXTURE_SETUP_HINT}`);
      await use(new FixtureApi(stagingTargets().api, credential));
    },
    { scope: "worker" },
  ],

  // One slot per concurrently running worker, across shards and CI jobs:
  // E2E_SLOT_BASE separates jobs that run at the same time (see the CI config).
  slot: [
    async ({}, use, workerInfo) => {
      const slotBase = Number(process.env.E2E_SLOT_BASE ?? 48);
      const shard = workerInfo.config.shard?.current ?? 1;
      const slot = slotBase + (shard - 1) * workerInfo.config.workers + workerInfo.parallelIndex;
      if (!Number.isInteger(slot) || slot < 0 || slot > 63) {
        throw new Error(`fixture slot ${slot} is outside 0–63; lower E2E_SLOT_BASE or the worker count`);
      }
      await use(slot);
    },
    { scope: "worker" },
  ],

  walletToman: [0, { option: true }],

  shopper: async ({ fixtureApi, slot, walletToman }, use) => {
    const shopper = await fixtureApi.provision(slot, walletToman);
    await use(shopper);
    await fixtureApi.cleanup(slot);
  },

  pageErrors: async ({ page }, use) => {
    const firstPartyHosts = Object.values(stagingTargets()).map((origin) => new URL(origin).host);
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      // WebKit reports a first-party request that a navigation cancelled (an
      // RSC prefetch, typically) as "… due to access control checks." That is
      // not a script failure; every other uncaught error still counts.
      const cancelledRequest =
        / due to access control checks\.$/.test(error.message) &&
        firstPartyHosts.some((host) => error.message.includes(host));
      if (!cancelledRequest) errors.push(error.message);
    });
    await use(errors);
  },

  stagingGuards: [
    async ({ context }, use) => {
      const liveGatewayHits: string[] = [];
      await context.route(LIVE_GATEWAY_PATTERN, (route) => {
        liveGatewayHits.push(route.request().url());
        return route.abort("blockedbyclient");
      });
      await context.route(THIRD_PARTY_PATTERN, (route) => route.abort("blockedbyclient"));
      await use();
      expect(liveGatewayHits, "a staging test reached a real-money payment gateway").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/**
 * The storefront sets <html data-app-ready="true"> once it has hydrated and
 * knows whether the shopper is signed in (components/ui/AppReadyMarker). A tap
 * before that can be dropped, so every full page load waits for it.
 */
export async function waitForAppReady(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("data-app-ready", "true");
}

export async function gotoStorefront(page: Page, path: string) {
  await page.goto(path);
  await waitForAppReady(page);
}

/** "۱۸۵٬۰۰۰ تومان" → 185000. */
export function tomanFromText(text: string): number {
  const digits = text
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[^\d]/g, "");
  return Number(digits || Number.NaN);
}

export async function readToman(locator: Locator): Promise<number> {
  await expect(locator).toBeVisible();
  return tomanFromText(await locator.innerText());
}

/** The shopper's local-format number, as the auth UI submits it. */
export const localPhone = (shopper: Shopper) => `0${shopper.phone.slice(3)}`;

/**
 * Sign in on the central auth page the storefront sent the guest to.
 *
 * The auth UI's phone step always sends an SMS code before offering the
 * password form, so the test makes the password page's own two requests
 * instead, from the auth page's browser context (its cookies): flow/start,
 * which records where to return (the page carries it as ?returnTo=), then the
 * password sign-in. It follows the hand-off link that returns, exactly as the
 * page would.
 */
export async function signInFromAuthPage(page: Page, shopper: Shopper) {
  const { auth } = stagingTargets();
  await expect(page).toHaveURL(new RegExp(`^${auth.replace(/[.]/g, "\\.")}/auth\\b`));
  const returnTo = new URL(page.url()).searchParams.get("returnTo");
  const flow = await page.request.post(`${auth}/api/auth/infinity/flow/start`, {
    data: { returnTo },
    headers: { Origin: auth },
  });
  expect(flow.ok(), `auth flow start failed (${flow.status()})`).toBe(true);
  const response = await page.request.post(`${auth}/api/auth/infinity/password/sign-in`, {
    data: { phone: localPhone(shopper), password: shopper.password },
    headers: { Origin: auth },
  });
  expect(response.ok(), `password sign-in failed (${response.status()})`).toBe(true);
  const { redirectTo } = (await response.json()) as { redirectTo?: string };
  expect(redirectTo, "sign-in must hand the shopper back to the storefront").toMatch(/\/auth\/callback\?grant=/);
  await page.goto(redirectTo!);
}

/** Sign in without the storefront round trip, for tests that start signed in. */
export async function signIn(page: Page, shopper: Shopper, path = "/") {
  const { storefront } = stagingTargets();
  await page.goto(`${stagingTargets().auth}/auth?returnTo=${encodeURIComponent(`${storefront}${path}`)}`);
  await signInFromAuthPage(page, shopper);
  await expect(page).toHaveURL(new RegExp(`^${storefront.replace(/[.]/g, "\\.")}${path.replace(/[?]/g, "\\?")}`));
  await waitForAppReady(page);
}

/** Strapi calls as the signed-in shopper, with a token from the browser's own session. */
export async function shopperApi(page: Page) {
  const { api, auth, storefront } = stagingTargets();
  const tokenResponse = await page.request.get(`${auth}/api/auth/token`, {
    headers: { Origin: storefront, Accept: "application/json" },
  });
  expect(tokenResponse.ok(), `session token request failed (${tokenResponse.status()})`).toBe(true);
  const { token } = (await tokenResponse.json()) as { token: string };
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  const unwrap = async (response: Awaited<ReturnType<Page["request"]["get"]>>, label: string) => {
    expect(response.ok(), `${label} failed (${response.status()}): ${await response.text()}`).toBe(true);
    return response.json();
  };
  return {
    get: async (path: string) => unwrap(await page.request.get(`${api}${path}`, { headers }), `GET ${path}`),
    post: async (path: string, data: unknown) =>
      unwrap(await page.request.post(`${api}${path}`, { headers, data }), `POST ${path}`),
    postRaw: (path: string, data: unknown) => page.request.post(`${api}${path}`, { headers, data }),
  };
}

export type ShopperApi = Awaited<ReturnType<typeof shopperApi>>;

/** The listing a campaign link lands on; cache-busted so a fresh fixture is visible. */
export async function openFixtureCategory(page: Page, shopper: Shopper) {
  await gotoStorefront(page, `/plp/category/${shopper.product.categorySlug}?_e2e=${randomUUID()}`);
}

/** The product's card in the listing's results (other rails may repeat it). */
export function productCardLink(page: Page, shopper: Shopper) {
  return page
    .getByTestId("plp-product-results")
    .getByRole("link", { name: `مشاهده جزئیات ${shopper.product.title}` });
}

/** Choose colour and size by their accessible names and add one unit. */
export async function addInStockVariationToCart(page: Page, shopper: Shopper) {
  const { color, size } = shopper.variations.inStock;
  await page.getByRole("button", { name: `انتخاب رنگ ${color}` }).click();
  await page.getByRole("button", { name: `انتخاب سایز ${size}` }).click();
  // The button is inert until the cart context hydrates.
  await expect(page.getByTestId("pdp-cart-action")).toHaveAttribute("data-cart-ready", "true");
  await page.getByRole("button", { name: "افزودن به سبد خرید" }).click();
  await expect(page.getByRole("button", { name: "در سبد خرید (مشاهده)" })).toBeVisible();
}

/** Every visible cart row (the desktop table and the mobile cards both render). */
export function cartRows(page: Page) {
  return page.locator('[data-testid="cart-item"]:visible');
}

export async function selectFixtureAddress(page: Page, shopper: Shopper) {
  const picker = page.getByTestId("checkout-address-select");
  await picker.getByRole("button").first().click();
  await page.getByRole("option", { name: new RegExp(shopper.address.fullAddress) }).click();
}

/** Pick the first delivery method offered for the address; returns its id. */
export async function selectFirstShipping(page: Page): Promise<number> {
  const option = page.getByTestId("checkout-shipping-option").first();
  await option.getByRole("radio").check();
  return Number(await option.getAttribute("data-shipping-id"));
}

/** The codes of the payment options the checkout shows. */
export async function offeredGateways(page: Page): Promise<string[]> {
  const gateways = page.locator('[data-testid^="payment-gateway-"]:visible');
  await expect(gateways.first()).toBeVisible();
  return (await gateways.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid") || "")))
    .map((testId) => testId.replace(/^payment-gateway-/, ""));
}

/** Delivery methods the server offers for the shopper's saved address. */
export async function shippingOptions(api: ShopperApi, addressId: number) {
  const body = await api.post("/carts/shipping-options", { addressId });
  const methods = (body.methods ?? body.data?.methods ?? []) as Array<{ id: number; price: number; title: string }>;
  expect(methods.length, "the server offers no delivery method for the fixture address").toBeGreaterThan(0);
  return methods;
}

/** The server's quote for what the checkout form currently says. */
export async function checkoutQuote(
  api: ShopperApi,
  input: { shipping: number; addressId: number; gateway: string; mobile: string },
) {
  const body = await api.post("/carts/quote", {
    shipping: input.shipping,
    addressId: input.addressId,
    gateway: input.gateway,
    callbackURL: "/orders/payment-callback",
    mobile: input.mobile,
  });
  return (body.data ?? body) as {
    quoteHash: string;
    financialSummary: { subtotal: number; shipping: number; total: number };
  };
}

/** Place an order through the same quote → finalize calls the checkout makes. */
export async function placeOrderThroughApi(
  api: ShopperApi,
  input: { shipping: number; addressId: number; gateway: string; mobile: string },
) {
  const quote = await checkoutQuote(api, input);
  const body = await api.post("/carts/finalize", {
    shipping: input.shipping,
    addressId: input.addressId,
    gateway: input.gateway,
    callbackURL: "/orders/payment-callback",
    mobile: input.mobile,
    attemptId: randomUUID(),
    quoteHash: quote.quoteHash,
  });
  return { quote, finalize: (body.data ?? body) as { orderId: number; redirectUrl?: string; paymentStatus?: string } };
}
