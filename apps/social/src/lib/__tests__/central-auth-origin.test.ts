import { exactCentralAuthOrigin } from "../central-auth-origin";

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
});

describe("Infinitygram central auth deployment authority", () => {
  it("accepts the frozen production auth origin in a production Next build", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      NEXT_PUBLIC_AUTH_ENVIRONMENT: "production",
      NEXT_PUBLIC_AUTH_ORIGIN: "https://auth.infinitycolor.co",
    });

    expect(exactCentralAuthOrigin()).toBe("https://auth.infinitycolor.co");
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
});
