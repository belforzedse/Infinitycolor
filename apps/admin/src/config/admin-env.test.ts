describe("admin environment contract", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    jest.resetModules();
  });

  it("accepts only the frozen production authorities", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT = "production";
    process.env.ADMIN_URL = "https://admin.infinitycolor.co";
    process.env.NEXT_PUBLIC_STOREFRONT_URL = "https://infinitycolor.co";
    process.env.NEXT_PUBLIC_API_URL = "https://api.infinitycolor.co/api";
    const { validateAdminRuntimeConfiguration } = require("./admin-env");
    expect(() => validateAdminRuntimeConfiguration()).not.toThrow();
  });

  it("rejects a staging authority in a production application", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT = "production";
    process.env.ADMIN_URL = "https://admin.staging.infinitycolor.co";
    process.env.NEXT_PUBLIC_STOREFRONT_URL = "https://infinitycolor.co";
    process.env.NEXT_PUBLIC_API_URL = "https://api.infinitycolor.co/api";
    const { validateAdminRuntimeConfiguration } = require("./admin-env");
    expect(() => validateAdminRuntimeConfiguration()).toThrow(
      /frozen production authority/,
    );
  });

  it("accepts only a loopback same-origin proxy for e2e browser API traffic", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT = "e2e";
    process.env.NEXT_PUBLIC_API_URL = "http://localhost:2891/api/backend";
    let { adminApiUrl } = require("./admin-env");
    expect(adminApiUrl()).toBe("http://localhost:2891/api/backend");

    jest.resetModules();
    process.env.NEXT_PUBLIC_API_URL = "http://untrusted-service:1337/api/backend";
    ({ adminApiUrl } = require("./admin-env"));
    expect(() => adminApiUrl()).toThrow(/frozen e2e API URL/);

    jest.resetModules();
    process.env.NEXT_PUBLIC_API_URL = "http://backend:1337/api";
    ({ adminApiUrl } = require("./admin-env"));
    expect(() => adminApiUrl()).toThrow(/ending exactly in \/api\/backend/);
  });

  it("makes dedicated Umami provisioning a staging and production readiness gate", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT = "staging";
    delete process.env.NEXT_PUBLIC_ADMIN_UMAMI_URL;
    delete process.env.NEXT_PUBLIC_ADMIN_UMAMI_WEBSITE_ID;
    const { validateAdminAnalyticsProvisioning } = require("./admin-env");
    expect(() => validateAdminAnalyticsProvisioning()).toThrow(
      /Dedicated admin Umami/,
    );
  });

  it("accepts only a canonical Umami UUID", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT = "production";
    process.env.NEXT_PUBLIC_ADMIN_UMAMI_URL = "https://analytics.alpagency.net";
    process.env.NEXT_PUBLIC_ADMIN_UMAMI_WEBSITE_ID =
      "123e4567-e89b-42d3-a456-426614174000";
    const { validateAdminAnalyticsProvisioning } = require("./admin-env");
    expect(() => validateAdminAnalyticsProvisioning()).not.toThrow();
  });

  it("rejects website ids that could smuggle a URL or credentials", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT = "production";
    process.env.NEXT_PUBLIC_ADMIN_UMAMI_URL = "https://analytics.alpagency.net";
    process.env.NEXT_PUBLIC_ADMIN_UMAMI_WEBSITE_ID =
      "https://collector.invalid";
    const { validateAdminAnalyticsProvisioning } = require("./admin-env");
    expect(() => validateAdminAnalyticsProvisioning()).toThrow(
      /canonical UUID/,
    );
  });

  it("rejects an analytics URL with a path", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT = "production";
    process.env.NEXT_PUBLIC_ADMIN_UMAMI_URL =
      "https://analytics.alpagency.net/private";
    process.env.NEXT_PUBLIC_ADMIN_UMAMI_WEBSITE_ID =
      "123e4567-e89b-42d3-a456-426614174000";
    const { validateAdminAnalyticsProvisioning } = require("./admin-env");
    expect(() => validateAdminAnalyticsProvisioning()).toThrow(
      /exact credential-free HTTPS origin/,
    );
  });
});
