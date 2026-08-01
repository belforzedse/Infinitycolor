import { exactCentralAuthOrigin } from "../central-auth-origin";

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
});

describe("central auth deployment authority", () => {
  it("accepts the frozen staging auth origin in a production Next build", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      NEXT_PUBLIC_AUTH_ENVIRONMENT: "staging",
      NEXT_PUBLIC_AUTH_ORIGIN: "https://auth.staging.infinitycolor.co",
    });

    expect(exactCentralAuthOrigin()).toBe("https://auth.staging.infinitycolor.co");
  });

  it("rejects a production/staging authority mix-up", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      NEXT_PUBLIC_AUTH_ENVIRONMENT: "production",
      NEXT_PUBLIC_AUTH_ORIGIN: "https://auth.staging.infinitycolor.co",
    });

    expect(() => exactCentralAuthOrigin()).toThrow(
      "production central auth origin must match its frozen authority",
    );
  });

  it("accepts the isolated loopback E2E authority in a production Next build", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      NEXT_PUBLIC_AUTH_ENVIRONMENT: "e2e",
      NEXT_PUBLIC_AUTH_ORIGIN: "http://localhost:2889",
    });

    expect(exactCentralAuthOrigin()).toBe("http://localhost:2889");
  });

  it("rejects a non-loopback authority for the E2E environment", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      NEXT_PUBLIC_AUTH_ENVIRONMENT: "e2e",
      NEXT_PUBLIC_AUTH_ORIGIN: "http://auth:2889",
    });

    expect(() => exactCentralAuthOrigin()).toThrow(
      "e2e central auth origin must match its frozen authority",
    );
  });
});
