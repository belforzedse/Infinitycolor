import type { JWTPayload } from "jose";
import { __betterAuthJwtTestUtils } from "../better-auth-jwt";

const validPayload = (): JWTPayload => ({
  iss: "https://auth.infinitycolor.co",
  aud: "https://api.infinitycolor.co",
  sub: "3917415c-3103-4ec1-804b-0c8a8059bcaa",
  sid: "b1b75ce0-b4f7-4f4b-b44a-c3b74486b374",
  jti: "413461d7-944d-4b4d-a25b-a3728e722752",
  strapi_user_id: 42,
  iat: 1_700_000_000,
  nbf: 1_699_999_999,
  exp: 1_700_000_060,
});

const VALID_NOW = 1_700_000_030;

describe("Better Auth JWT pinned claims", () => {
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnvironment)) delete process.env[key];
    }
    Object.assign(process.env, originalEnvironment);
  });

  test("accepts only an EdDSA token with kid and a 60-second numeric identity", () => {
    expect(
      __betterAuthJwtTestUtils.validatePinnedClaims(
        validPayload(),
        {
          alg: "EdDSA",
          kid: "current-key",
        },
        VALID_NOW,
      ),
    ).toBe(42);
  });

  test.each([
    ["wrong algorithm", { alg: "HS256", kid: "current-key" }, validPayload()],
    ["missing key id", { alg: "EdDSA" }, validPayload()],
    [
      "string identity",
      { alg: "EdDSA", kid: "current-key" },
      { ...validPayload(), strapi_user_id: "42" },
    ],
    [
      "zero identity",
      { alg: "EdDSA", kid: "current-key" },
      { ...validPayload(), strapi_user_id: 0 },
    ],
    [
      "missing session",
      { alg: "EdDSA", kid: "current-key" },
      { ...validPayload(), sid: undefined },
    ],
    ["missing jti", { alg: "EdDSA", kid: "current-key" }, { ...validPayload(), jti: undefined }],
    [
      "long lifetime",
      { alg: "EdDSA", kid: "current-key" },
      { ...validPayload(), exp: 1_700_000_061 },
    ],
    ["future nbf", { alg: "EdDSA", kid: "current-key" }, { ...validPayload(), nbf: 1_700_000_001 }],
  ])("rejects %s", (_label, header, payload) => {
    expect(__betterAuthJwtTestUtils.validatePinnedClaims(payload, header, VALID_NOW)).toBeNull();
  });

  test("does not let clock tolerance extend validity beyond exp", () => {
    expect(
      __betterAuthJwtTestUtils.validatePinnedClaims(
        validPayload(),
        { alg: "EdDSA", kid: "current-key" },
        1_700_000_060,
      ),
    ).toBeNull();
  });

  test("requires one exact issuer and audience rather than a matching audience set", () => {
    expect(
      __betterAuthJwtTestUtils.hasExactAuthorityClaims(
        validPayload(),
        "https://auth.infinitycolor.co",
        "https://api.infinitycolor.co",
      ),
    ).toBe(true);
    expect(
      __betterAuthJwtTestUtils.hasExactAuthorityClaims(
        {
          ...validPayload(),
          aud: ["https://api.infinitycolor.co", "https://other.example"],
        },
        "https://auth.infinitycolor.co",
        "https://api.infinitycolor.co",
      ),
    ).toBe(false);
  });

  test("requires both nonblank names for customer profile completion", () => {
    expect(
      __betterAuthJwtTestUtils.hasRequiredProfileNames({
        FirstName: " نیما ",
        LastName: " احمدی ",
      }),
    ).toBe(true);
    expect(
      __betterAuthJwtTestUtils.hasRequiredProfileNames({ FirstName: "نیما", LastName: " " }),
    ).toBe(false);
    expect(__betterAuthJwtTestUtils.hasRequiredProfileNames(null)).toBe(false);
  });

  test("keeps management roles out of the customer signup-completion gate", () => {
    expect(__betterAuthJwtTestUtils.isManagementRole("Superadmin")).toBe(true);
    expect(__betterAuthJwtTestUtils.isManagementRole("Store manager")).toBe(true);
    expect(__betterAuthJwtTestUtils.isManagementRole("Customer")).toBe(false);
  });

  test("pins staging to its HTTPS JWKS issuer and audience", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      BETTER_AUTH_BRIDGE_ENABLED: "true",
      BETTER_AUTH_ENVIRONMENT: "staging",
      BETTER_AUTH_JWKS_URL: "https://auth.staging.infinitycolor.co/api/auth/jwks",
      BETTER_AUTH_JWT_ISSUER: "https://auth.staging.infinitycolor.co",
      BETTER_AUTH_JWT_AUDIENCE: "https://api.staging.infinitycolor.co",
      BETTER_AUTH_JWT_CLOCK_TOLERANCE_SECONDS: "5",
    });

    const config = __betterAuthJwtTestUtils.getConfig();
    expect(config?.issuer).toBe("https://auth.staging.infinitycolor.co");
    expect(config?.audience).toBe("https://api.staging.infinitycolor.co");
    expect(config?.jwksUrl.href).toBe("https://auth.staging.infinitycolor.co/api/auth/jwks");
  });

  test("pins production to its exact HTTPS JWKS transport and public authority", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      BETTER_AUTH_BRIDGE_ENABLED: "true",
      BETTER_AUTH_ENVIRONMENT: "production",
      BETTER_AUTH_JWKS_URL: "https://auth.infinitycolor.co/api/auth/jwks",
      BETTER_AUTH_JWT_ISSUER: "https://auth.infinitycolor.co",
      BETTER_AUTH_JWT_AUDIENCE: "https://api.infinitycolor.co",
    });

    const config = __betterAuthJwtTestUtils.getConfig();
    expect(config?.jwksUrl.href).toBe("https://auth.infinitycolor.co/api/auth/jwks");
    expect(config?.issuer).toBe("https://auth.infinitycolor.co");
    expect(config?.audience).toBe("https://api.infinitycolor.co");

    process.env.BETTER_AUTH_JWKS_URL = "http://auth:2889/api/auth/jwks";
    expect(() => __betterAuthJwtTestUtils.getConfig()).toThrow(
      "production Better Auth JWKS, issuer, and audience must match the frozen authorities",
    );
  });

  test.each([
    ["JWKS timeout", { code: "ERR_JWKS_TIMEOUT" }],
    ["invalid JWKS", { code: "ERR_JWKS_INVALID" }],
    ["JWKS fetch failure", new TypeError("fetch failed")],
    ["nested network failure", { cause: new TypeError("fetch failed") }],
  ])("classifies %s as an infrastructure failure", (_label, error) => {
    expect(__betterAuthJwtTestUtils.isJwksInfrastructureError(error)).toBe(true);
  });

  test.each([
    ["expired token", { code: "ERR_JWT_EXPIRED" }],
    ["invalid signature", { code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" }],
    ["unknown key", { code: "ERR_JWKS_NO_MATCHING_KEY" }],
  ])("keeps %s in the invalid-credential path", (_label, error) => {
    expect(__betterAuthJwtTestUtils.isJwksInfrastructureError(error)).toBe(false);
  });

  test("permits only the frozen isolated E2E authority in the Infinity GitLab project", () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      CI: "1",
      GITLAB_CI: "true",
      CI_PROJECT_PATH: "bel4/infinity",
      BETTER_AUTH_BRIDGE_ENABLED: "true",
      BETTER_AUTH_ENVIRONMENT: "e2e",
      BETTER_AUTH_JWKS_URL: "http://build:2889/api/auth/jwks",
      BETTER_AUTH_JWT_ISSUER: "http://localhost:2889",
      BETTER_AUTH_JWT_AUDIENCE: "http://backend:1337",
      BETTER_AUTH_JWT_CLOCK_TOLERANCE_SECONDS: "5",
    });

    const config = __betterAuthJwtTestUtils.getConfig();
    expect(config?.issuer).toBe("http://localhost:2889");
    expect(config?.audience).toBe("http://backend:1337");
    expect(config?.jwksUrl.href).toBe("http://build:2889/api/auth/jwks");

    process.env.BETTER_AUTH_JWKS_URL = "http://backend:2889/api/auth/jwks";
    expect(() => __betterAuthJwtTestUtils.getConfig()).toThrow(
      "e2e Better Auth JWKS, issuer, and audience must match the frozen authorities",
    );
  });

  test.each([
    ["outside GitLab CI", { GITLAB_CI: "false", CI_PROJECT_PATH: "bel4/infinity" }],
    ["in another project", { GITLAB_CI: "true", CI_PROJECT_PATH: "bel4/other" }],
  ])("rejects the isolated E2E authority %s", (_label, ciEnvironment) => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      ...ciEnvironment,
      BETTER_AUTH_BRIDGE_ENABLED: "true",
      BETTER_AUTH_ENVIRONMENT: "e2e",
      BETTER_AUTH_JWKS_URL: "http://build:2889/api/auth/jwks",
      BETTER_AUTH_JWT_ISSUER: "http://localhost:2889",
      BETTER_AUTH_JWT_AUDIENCE: "http://backend:1337",
    });

    expect(() => __betterAuthJwtTestUtils.getConfig()).toThrow(
      "The e2e Better Auth environment is restricted to the Infinity GitLab CI project",
    );
  });
});
