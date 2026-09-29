jest.mock("next/server", () => ({
  NextResponse: {
    next: jest.fn(() => ({ headers: new Headers() })),
    redirect: jest.fn((url: URL, status: number) => ({
      headers: new Headers(),
      status,
      url,
    })),
    json: jest.fn((body: unknown, init: ResponseInit) => ({
      body,
      headers: new Headers(init.headers),
      status: init.status,
    })),
  },
}));

const {
  AUTH_REDIRECT_STATUS,
  ADMIN_CUTOVER_REDIRECT_STATUS,
  getAdminCutoverRedirectUrl,
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

function mockRequest(path: string, hasAuthMarker = false, origin?: string, method = "GET") {
  return {
    method,
    nextUrl: nextUrl(path, origin),
    cookies: {
      get: (name: string) =>
        hasAuthMarker && name === AUTH_ROUTE_HINT_COOKIE
          ? { value: AUTH_ROUTE_HINT_COOKIE_VALUE }
          : undefined,
    },
  };
}

describe("admin cutover redirect", () => {
  const previous = {
    enabled: process.env.ADMIN_REDIRECT_ENABLED,
    environment: process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT,
  };

  afterEach(() => {
    if (previous.enabled === undefined) delete process.env.ADMIN_REDIRECT_ENABLED;
    else process.env.ADMIN_REDIRECT_ENABLED = previous.enabled;
    if (previous.environment === undefined) delete process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT;
    else process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT = previous.environment;
  });

  it("maps the old prefix to fixed root paths while preserving queries", () => {
    process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT = "production";
    expect(
      getAdminCutoverRedirectUrl(new URL("/super-admin?tab=1", "https://untrusted.example"))?.href,
    ).toBe("https://admin.infinitycolor.co/?tab=1");
    expect(
      getAdminCutoverRedirectUrl(
        new URL("/super-admin/products/edit/12?return=orders", "https://untrusted.example"),
      )?.href,
    ).toBe("https://admin.infinitycolor.co/products/edit/12?return=orders");
  });

  it("does nothing until the cutover switch is explicitly enabled", async () => {
    delete process.env.ADMIN_REDIRECT_ENABLED;
    const response = await proxy(mockRequest("/super-admin/products", true));
    expect(response.url).toBeUndefined();
  });

  it("uses a temporary no-store 307 for GET and HEAD", async () => {
    process.env.ADMIN_REDIRECT_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT = "staging";
    for (const method of ["GET", "HEAD"]) {
      const response = await proxy(
        mockRequest("/super-admin/orders?page=2", true, "https://host-header.invalid", method),
      );
      expect(response.status).toBe(ADMIN_CUTOVER_REDIRECT_STATUS);
      expect(response.url.href).toBe("https://admin.staging.infinitycolor.co/orders?page=2");
      expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    }
  });

  it("moves legacy storefront report bookmarks to the extracted admin", async () => {
    process.env.ADMIN_REDIRECT_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT = "production";
    const response = await proxy(
      mockRequest("/super-admin/reports/traffic?range=30d", true, "https://untrusted.example"),
    );
    expect(response.status).toBe(ADMIN_CUTOVER_REDIRECT_STATUS);
    expect(response.url.href).toBe(
      "https://admin.infinitycolor.co/sales/traffic?range=30d&view=overview",
    );
  });

  it("maps old report views and ranges directly into the consolidated admin", () => {
    process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT = "production";
    expect(
      getAdminCutoverRedirectUrl(
        new URL(
          "/super-admin/reports/traffic?from=2026-01-01&to=2026-01-31&tab=ecommerce&utm_source=email",
          "https://untrusted.example",
        ),
      )?.href,
    ).toBe(
      "https://admin.infinitycolor.co/sales/traffic?start=2026-01-01&end=2026-01-31&utmSource=email&view=conversion",
    );
    expect(
      getAdminCutoverRedirectUrl(
        new URL(
          "/super-admin/reports/gateway-liquidity?start=2026-01-01",
          "https://untrusted.example",
        ),
      )?.href,
    ).toBe("https://admin.infinitycolor.co/sales/liquidity?start=2026-01-01&section=gateways");
  });

  it("rejects methods that must never cross the application boundary", async () => {
    process.env.ADMIN_REDIRECT_ENABLED = "true";
    process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT = "production";
    const response = await proxy(mockRequest("/super-admin/products", true, undefined, "POST"));
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD");
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
  });
});

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

  it("redirects the old newest offer listing to the Newest page, keeping its page", () => {
    const target = legacyTarget("/offer/newest/");
    expect(target?.pathname).toBe("/offer");
    expect(target?.search).toBe("?type=newest");

    const paged = legacyTarget("/offer/newest/page/3/");
    expect(paged?.pathname).toBe("/offer");
    expect(paged?.searchParams.get("type")).toBe("newest");
    expect(paged?.searchParams.get("page")).toBe("3");

    // The new page itself is never redirected.
    expect(legacyTarget("/offer?type=newest")).toBeNull();
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

  it("redirects return policy Persian URL to the returns page", () => {
    const target = legacyTarget("/شرایط-و-مقررات-تعویض-و-مرجوع/");

    expect(target?.pathname).toBe("/returns");
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

describe("middleware PDP canonical redirects", () => {
  const previousFetch = global.fetch;

  afterEach(() => {
    global.fetch = previousFetch;
  });

  it("301s a numeric PDP id to the decoded canonical slug", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { attributes: { Slug: "scarf-around-zip-oppsi-s00518" } } }),
    }) as any;

    const response = await proxy(mockRequest("/pdp/123"));

    expect(response.status).toBe(LEGACY_REDIRECT_STATUS);
    expect(response.url.pathname).toBe("/pdp/scarf-around-zip-oppsi-s00518");
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/products/123?"),
      expect.any(Object),
    );
  });

  it("301s a historical percent-encoded PDP slug to the decoded Persian form", async () => {
    const persian = "ست-تاپ-و-دامن-فلامنت-y00574";
    const encoded =
      "%d8%b3%d8%aa-%d8%aa%d8%a7%d9%be-%d9%88-%d8%af%d8%a7%d9%85%d9%86-%d9%81%d9%84%d8%a7%d9%85%d9%86%d8%aa-y00574";
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { attributes: { Slug: persian } } }),
    }) as any;

    const response = await proxy(mockRequest(`/pdp/${encoded}`));

    expect(response.status).toBe(LEGACY_REDIRECT_STATUS);
    expect(response.url.pathname).toBe(`/pdp/${encodeURIComponent(persian)}`);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/products/by-slug/"),
      expect.any(Object),
    );
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
