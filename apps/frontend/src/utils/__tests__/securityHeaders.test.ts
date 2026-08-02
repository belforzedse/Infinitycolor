import { getContentSecurityPolicyReportOnly, getSecurityHeaders } from "../securityHeaders";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  NEXT_PUBLIC_IMAGE_BASE_URL: process.env.NEXT_PUBLIC_IMAGE_BASE_URL,
  NEXT_PUBLIC_MATOMO_URL: process.env.NEXT_PUBLIC_MATOMO_URL,
  NEXT_PUBLIC_AUTH_ORIGIN: process.env.NEXT_PUBLIC_AUTH_ORIGIN,
};

function restoreEnvValue(key: keyof typeof originalEnv) {
  const value = originalEnv[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("securityHeaders", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_API_BASE_URL = "https://api.infinitycolor.co/api";
    process.env.NEXT_PUBLIC_IMAGE_BASE_URL = "https://api.infinitycolor.co";
    delete process.env.NEXT_PUBLIC_MATOMO_URL;
    process.env.NEXT_PUBLIC_AUTH_ORIGIN = "https://auth.infinitycolor.co";
  });

  afterEach(() => {
    restoreEnvValue("NODE_ENV");
    restoreEnvValue("NEXT_PUBLIC_API_BASE_URL");
    restoreEnvValue("NEXT_PUBLIC_IMAGE_BASE_URL");
    restoreEnvValue("NEXT_PUBLIC_MATOMO_URL");
    restoreEnvValue("NEXT_PUBLIC_AUTH_ORIGIN");
  });

  it("builds the hardened baseline headers", () => {
    const headers = new Map(getSecurityHeaders().map(({ key, value }) => [key, value]));

    expect(headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("Permissions-Policy")).toContain("payment=()");
    expect(headers.has("Content-Security-Policy")).toBe(false);
    expect(headers.has("Content-Security-Policy-Report-Only")).toBe(true);
  });

  it("keeps CSP report-only scoped to explicit sources", () => {
    const csp = getContentSecurityPolicyReportOnly();

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://www.zarinpal.com https://sandbox.zarinpal.com");
    expect(csp).toContain("https://api.infinitycolor.co");
    expect(csp).toContain("https://matomo.alpagency.net");
    expect(csp).toContain("connect-src 'self' https://api.infinitycolor.co https://matomo.alpagency.net https://auth.infinitycolor.co");
    expect(csp).not.toContain("*");
    expect(csp).not.toMatch(/(^|[ ;])https:([ ;]|$)/);
    expect(csp).not.toMatch(/(^|[ ;])http:([ ;]|$)/);
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
});
