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
  default: middleware,
  getLegacyRedirectUrl,
  isRetiredLegacyPath,
  LEGACY_REDIRECT_STATUS,
} = require("../../middleware");
const { getSecurityHeaderEntries } = require("../utils/securityHeaders");
const { legacyRedirects } = require("../../redirects");

const SECURITY_HEADER_EXPECTATIONS = [
  ["X-DNS-Prefetch-Control", "on"],
  ...getSecurityHeaderEntries(),
] as const;

function legacyTarget(path: string) {
  return getLegacyRedirectUrl(new URL(path, "https://infinitycolor.co"));
}

function nextUrl(path: string) {
  const url = new URL(path, "https://infinitycolor.co");
  url.clone = () => nextUrl(url.pathname + url.search);

  return url;
}

function mockRequest(path: string) {
  return {
    nextUrl: nextUrl(path),
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
  ])(
    "leaves the established payment result route unchanged: %s",
    (path) => {
      expect(legacyTarget(path)).toBeNull();
    },
  );

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

    expect(legacyRedirects.filter((entry: { source: string }) => paymentResultSources.has(entry.source)))
      .toEqual([]);
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
    const response = await middleware(mockRequest("/"));

    expectSecurityHeaders(response.headers);
  });

  it("adds baseline security headers to legacy redirect responses", async () => {
    const response = await middleware(mockRequest("/shop/pants/page/2/"));

    expect(response.status).toBe(LEGACY_REDIRECT_STATUS);
    expectSecurityHeaders(response.headers);
  });

  it("adds baseline security headers to canonical redirect responses", async () => {
    const response = await middleware(mockRequest("/faq/"));

    expect(response.status).toBe(LEGACY_REDIRECT_STATUS);
    expectSecurityHeaders(response.headers);
  });
});
