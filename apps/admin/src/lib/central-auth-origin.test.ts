describe("admin central auth environment contract", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    jest.resetModules();
  });

  it("accepts the exact staging auth authority when the auth environment is explicit", () => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT = "staging";
    process.env.NEXT_PUBLIC_AUTH_URL = "https://auth.staging.infinitycolor.co";
    delete process.env.NEXT_PUBLIC_AUTH_ORIGIN;

    const { exactCentralAuthOrigin } = require("./central-auth-origin");
    expect(exactCentralAuthOrigin()).toBe("https://auth.staging.infinitycolor.co");
  });

  it("fails closed when a production build omits the auth environment", () => {
    process.env.NODE_ENV = "production";
    delete process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT;
    process.env.NEXT_PUBLIC_AUTH_URL = "https://auth.staging.infinitycolor.co";
    delete process.env.NEXT_PUBLIC_AUTH_ORIGIN;

    const { exactCentralAuthOrigin } = require("./central-auth-origin");
    expect(() => exactCentralAuthOrigin()).toThrow(
      /NEXT_PUBLIC_AUTH_ENVIRONMENT is required/,
    );
  });
});
