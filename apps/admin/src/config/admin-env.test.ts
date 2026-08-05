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
    process.env.NEXT_PUBLIC_STOREFRONT_URL = "https://new.infinitycolor.co";
    process.env.NEXT_PUBLIC_API_URL = "https://api.infinitycolor.co/api";
    const { validateAdminRuntimeConfiguration } = require("./admin-env");
    expect(() => validateAdminRuntimeConfiguration()).not.toThrow();
  });

  it("rejects a staging authority in a production application", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT = "production";
    process.env.ADMIN_URL = "https://admin.staging.infinitycolor.co";
    process.env.NEXT_PUBLIC_STOREFRONT_URL = "https://new.infinitycolor.co";
    process.env.NEXT_PUBLIC_API_URL = "https://api.infinitycolor.co/api";
    const { validateAdminRuntimeConfiguration } = require("./admin-env");
    expect(() => validateAdminRuntimeConfiguration()).toThrow(/frozen production authority/);
  });

  it("accepts only loopback or the frozen GitLab service URL for e2e API traffic", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT = "e2e";
    process.env.NEXT_PUBLIC_API_URL = "http://backend:1337/api";
    let { adminApiUrl } = require("./admin-env");
    expect(adminApiUrl()).toBe("http://backend:1337/api");

    jest.resetModules();
    process.env.NEXT_PUBLIC_API_URL = "http://untrusted-service:1337/api";
    ({ adminApiUrl } = require("./admin-env"));
    expect(() => adminApiUrl()).toThrow(/frozen e2e API URL/);
  });

  it("makes dedicated analytics provisioning a staging and production readiness gate", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT = "staging";
    delete process.env.NEXT_PUBLIC_ADMIN_MATOMO_URL;
    delete process.env.NEXT_PUBLIC_ADMIN_MATOMO_SITE_ID;
    const { validateAdminAnalyticsProvisioning } = require("./admin-env");
    expect(() => validateAdminAnalyticsProvisioning()).toThrow(/Dedicated admin Matomo/);
  });
});
