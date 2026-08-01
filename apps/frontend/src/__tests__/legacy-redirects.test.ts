jest.mock("next/server", () => ({
  NextResponse: {
    next: jest.fn(() => ({ headers: new Headers() })),
    redirect: jest.fn((url: URL, status: number) => ({
      headers: new Headers(),
      status,
      url,
    })),
  },
}));

const {
  AUTH_REDIRECT_STATUS,
  getLegacyRedirectUrl,
  isAuthRequiredRoute,
  isRetiredLegacyPath,
  LEGACY_REDIRECT_STATUS,
  proxy,
} = require("../proxy");
const { AUTH_ROUTE_HINT_COOKIE, AUTH_ROUTE_HINT_COOKIE_VALUE } = require("../utils/authRouteHint");
const { getSecurityHeaderEntries } = require("../utils/securityHeaders");
const { SITE_URL } = require("../config/site");
const { legacyRedirects } = require("../../redirects");

const SECURITY_HEADER_EXPECTATIONS = [
  ["X-DNS-Prefetch-Control", "on"],
  ...getSecurityHeaderEntries(),
] as const;

function legacyTarget(path: string) {
  return getLegacyRedirectUrl(new URL(path, "https://infinitycolor.co"));
}

function nextUrl(path: string, origin = "https://infinitycolor.co") {
  const url = new URL(path, origin);
  url.clone = () => nextUrl(url.pathname + url.search, origin);

  return url;
}

function mockRequest(path: string, hasAuthMarker = false, origin?: string) {
  return {
    nextUrl: nextUrl(path, origin),
    cookies: {
      get: (name: string) =>
        hasAuthMarker && name === AUTH_ROUTE_HINT_COOKIE
          ? { value: AUTH_ROUTE_HINT_COOKIE_VALUE }
          : undefined,
    },
  };
}

function expectSecurityHeaders(headers: Headers) {
  for (const [key, value] of SECURITY_HEADER_EXPECTATIONS) {
    expect(headers.get(key)).toBe(value);
  }
}

describe("legacy WooCommerce redirects", () => {
  it("uses permanent 301 redirects", () => {
    expect(LEGACY_REDIRECT_STATUS).toBe(301);
  });

  it("redirects product variation URLs to canonical PDPs", () => {
    const target = legacyTarget("/product/teddy-pants-z0051/?pa_color=کرم");

    expect(target?.pathname).toBe("/pdp/teddy-pants-z0051");
    expect(target?.search).toBe("");
  });

  it("preserves category pagination as PLP pagination", () => {
    const target = legacyTarget("/shop/pants/page/2/");

    expect(target?.pathname).toBe("/plp/category/pants");
    expect(target?.searchParams.get("page")).toBe("2");
  });

  it("redirects nested product categories using the final slug segment", () => {
    const target = legacyTarget("/shop/coat/shacket/");

    expect(target?.pathname).toBe("/plp/category/shacket");
    expect(target?.search).toBe("");
  });

  it("redirects Oppsi offer URLs to product search", () => {
    const target = legacyTarget("/offer/oppsi/");

    expect(target?.pathname).toBe("/plp");
    expect(target?.searchParams.get("search")).toBe("Oppsi");
  });

  it("redirects damaged-products Persian URL to Oppsi search", () => {
    const target = legacyTarget("/محصولات-زده-دار/");

    expect(target?.pathname).toBe("/plp");
    expect(target?.searchParams.get("search")).toBe("Oppsi");
  });

  it("redirects return policy Persian URL to FAQ", () => {
    const target = legacyTarget("/شرایط-و-مقررات-تعویض-و-مرجوع/");

    expect(target?.pathname).toBe("/faq");
    expect(target?.search).toBe("");
  });

  it.each([
    "/orders/payment-callback?ResNum=51&RefNum=abc",
    "/orders/success?orderId=42",
    "/orders/failure?error=failed",
    "/payment/success?orderId=42",
  ])("leaves the established payment result route unchanged: %s", (path) => {
    expect(legacyTarget(path)).toBeNull();
  });

  it("does not register framework redirects for the established payment result pages", () => {
    const paymentResultSources = new Set([
      "/orders/success",
      "/orders/failure",
      "/payment/success",
      "/payment/failure",
      "/payment/cancelled",
      "/payment/issue",
      "/orders/payment-callback",
    ]);

    expect(
      legacyRedirects.filter((entry: { source: string }) => paymentResultSources.has(entry.source)),
    ).toEqual([]);
  });

  it("redirects nested blog categories to blog category filters", () => {
    const target = legacyTarget("/category/مد-و-پوشاک/انواع-استایل/");

    expect(target?.pathname).toBe("/blog");
    expect(target?.searchParams.get("category")).toBe("انواع-استایل");
  });

  it("does not redirect retired offer URLs", () => {
    const target = legacyTarget("/offer/best-sellers/");

    expect(target).toBeNull();
    expect(isRetiredLegacyPath("/offer/best-sellers/")).toBe(true);
  });
});

describe("middleware security headers", () => {
  it("adds baseline security headers to pass-through responses", async () => {
    const response = await proxy(mockRequest("/"));

    expectSecurityHeaders(response.headers);
  });

  it("adds baseline security headers to legacy redirect responses", async () => {
    const response = await proxy(mockRequest("/shop/pants/page/2/"));

    expect(response.status).toBe(LEGACY_REDIRECT_STATUS);
    expectSecurityHeaders(response.headers);
  });

  it("adds baseline security headers to canonical redirect responses", async () => {
    const response = await proxy(mockRequest("/faq/"));

    expect(response.status).toBe(LEGACY_REDIRECT_STATUS);
    expectSecurityHeaders(response.headers);
  });
});

describe("middleware authenticated route gate", () => {
  it("redirects a logged-out account request before rendering the account route", async () => {
    const response = await proxy(mockRequest("/account?tab=profile"));

    expect(response.status).toBe(AUTH_REDIRECT_STATUS);
    expect(response.url.pathname).toBe("/auth");
    expect(response.url.searchParams.get("redirect")).toBe("/account?tab=profile");
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(response.headers.get("Vary")).toBe("Cookie");
    expectSecurityHeaders(response.headers);
  });

  it("allows an account request with the optimistic route marker to continue", async () => {
    const response = await proxy(mockRequest("/account", true));

    expect(response.url).toBeUndefined();
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expectSecurityHeaders(response.headers);
  });

  it("uses the public auth origin for browser redirects, not the server-only origin", async () => {
    const previous = {
      cutover: process.env.CENTRAL_AUTH_CUTOVER_ENABLED,
      publicOrigin: process.env.NEXT_PUBLIC_AUTH_ORIGIN,
      serverOrigin: process.env.AUTH_SERVER_ORIGIN,
    };
    process.env.CENTRAL_AUTH_CUTOVER_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTH_ORIGIN = "https://auth.infinitycolor.co";
    process.env.AUTH_SERVER_ORIGIN = "http://auth.internal:2889";
    try {
      const response = await proxy(
        mockRequest("/account?tab=profile", false, "http://0.0.0.0:3000"),
      );

      expect(response.status).toBe(AUTH_REDIRECT_STATUS);
      expect(response.url.origin).toBe("https://auth.infinitycolor.co");
      expect(response.url.searchParams.get("returnTo")).toBe(
        new URL("/account?tab=profile", SITE_URL).toString(),
      );
    } finally {
      if (previous.cutover === undefined) delete process.env.CENTRAL_AUTH_CUTOVER_ENABLED;
      else process.env.CENTRAL_AUTH_CUTOVER_ENABLED = previous.cutover;
      if (previous.publicOrigin === undefined) delete process.env.NEXT_PUBLIC_AUTH_ORIGIN;
      else process.env.NEXT_PUBLIC_AUTH_ORIGIN = previous.publicOrigin;
      if (previous.serverOrigin === undefined) delete process.env.AUTH_SERVER_ORIGIN;
      else process.env.AUTH_SERVER_ORIGIN = previous.serverOrigin;
    }
  });

  it.each([
    "/account",
    "/addresses/12",
    "/checkout",
    "/favorites",
    "/orders",
    "/orders/123",
    "/password",
    "/privileges",
    "/super-admin/products",
    "/wallet",
  ])("classifies authenticated route %s", (path) => {
    expect(isAuthRequiredRoute(path)).toBe(true);
  });

  it.each([
    "/",
    "/auth",
    "/cart",
    "/payment/result",
    "/orders/payment-callback",
    "/orders/success",
    "/orders/failure",
  ])("does not gate public or payment-recovery route %s", (path) => {
    expect(isAuthRequiredRoute(path)).toBe(false);
  });
});
