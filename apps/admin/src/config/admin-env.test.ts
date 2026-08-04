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

  it("makes dedicated analytics provisioning a staging and production readiness gate", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT = "staging";
    delete process.env.NEXT_PUBLIC_ADMIN_MATOMO_URL;
    delete process.env.NEXT_PUBLIC_ADMIN_MATOMO_SITE_ID;
    const { validateAdminAnalyticsProvisioning } = require("./admin-env");
    expect(() => validateAdminAnalyticsProvisioning()).toThrow(/Dedicated admin Matomo/);
  });
});
