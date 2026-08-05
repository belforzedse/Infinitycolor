import { parseExactOrigins } from "@repo/auth-core/redirects";

const PRODUCTION_AUTH_ORIGIN = "https://auth.infinitycolor.co";
const PRODUCTION_API_AUDIENCE = "https://api.infinitycolor.co";
const STAGING_AUTH_ORIGIN = "https://auth.staging.infinitycolor.co";
const STAGING_API_AUDIENCE = "https://api.staging.infinitycolor.co";

export interface AuthEnvironment {
  nodeEnv: "development" | "test" | "production";
  deploymentEnvironment: "development" | "staging" | "production";
  betterAuthUrl: string;
  betterAuthSecret: string;
  databaseUrl: string;
  flowSecret: string;
  trustedStorefrontOrigins: readonly string[];
  trustedAdminOrigins: readonly string[];
  trustedApplicationOrigins: readonly string[];
  defaultStorefrontOrigin: string;
  strapiInternalUrl: string;
  bridgeSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  jwtTtlSeconds: 60;
  jwtExpirationTime: "60s";
  jwksRotationSeconds: 2_592_000;
  jwksGraceSeconds: 86_400;
  sessionTtlSeconds: 604_800;
}

let cached: AuthEnvironment | undefined;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function exactInteger(name: string, expected: number): number {
  const raw = required(name);
  if (!/^\d+$/.test(raw) || Number(raw) !== expected) {
    throw new Error(`${name} must be exactly ${expected}`);
  }
  return expected;
}

function exactOrigin(name: string): string {
  const raw = required(name);
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an exact HTTP(S) origin`);
  }
  return url.origin;
}

function serviceOrigin(name: string): string {
  const raw = required(name);
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `${name} must be an HTTP(S) URL without embedded credentials`,
    );
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function strongSecret(name: string): string {
  const value = required(name);
  if (value.length < 32 || /^replace-/i.test(value)) {
    throw new Error(
      `${name} must contain at least 32 non-placeholder characters`,
    );
  }
  return value;
}

function deploymentEnvironment(
  nodeEnv: AuthEnvironment["nodeEnv"],
): AuthEnvironment["deploymentEnvironment"] {
  const value = process.env.AUTH_DEPLOYMENT_ENV?.trim();
  if (!value) {
    if (nodeEnv === "production") {
      throw new Error("AUTH_DEPLOYMENT_ENV is required in production mode");
    }
    return "development";
  }
  if (
    value !== "development" &&
    value !== "staging" &&
    value !== "production"
  ) {
    throw new Error(
      "AUTH_DEPLOYMENT_ENV must be development, staging, or production",
    );
  }
  if (nodeEnv === "production" && value === "development") {
    throw new Error(
      "A production build cannot use the development auth environment",
    );
  }
  return value;
}

export function getAuthEnv(): AuthEnvironment {
  if (cached) return cached;
  const nodeEnv = (process.env.NODE_ENV ??
    "development") as AuthEnvironment["nodeEnv"];
  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }
  const environment = deploymentEnvironment(nodeEnv);

  const trustedStorefrontOrigins = parseExactOrigins(
    required("AUTH_TRUSTED_STOREFRONT_ORIGINS"),
  );
  const defaultStorefrontOrigin = exactOrigin("AUTH_DEFAULT_STOREFRONT_ORIGIN");
  if (!trustedStorefrontOrigins.includes(defaultStorefrontOrigin)) {
    throw new Error(
      "AUTH_DEFAULT_STOREFRONT_ORIGIN must be explicitly trusted",
    );
  }

  if (environment !== "development") {
    const frozen = new Set(
      environment === "production"
        ? ["https://new.infinitycolor.co", "https://infinitycolor.co"]
        : ["https://staging.infinitycolor.co"],
    );
    if (
      trustedStorefrontOrigins.length !== frozen.size ||
      trustedStorefrontOrigins.some((origin) => !frozen.has(origin))
    ) {
      throw new Error(
        `${environment} storefront origins must match its frozen allowlist`,
      );
    }
  }

  const defaultAdminOrigin =
    environment === "production"
      ? "https://admin.infinitycolor.co"
      : environment === "staging"
        ? "https://admin.staging.infinitycolor.co"
        : "http://localhost:2891";
  const trustedAdminOrigins = parseExactOrigins(
    process.env.AUTH_TRUSTED_ADMIN_ORIGINS?.trim() || defaultAdminOrigin,
  );
  if (
    environment !== "development" &&
    (trustedAdminOrigins.length !== 1 || trustedAdminOrigins[0] !== defaultAdminOrigin)
  ) {
    throw new Error(`${environment} admin origins must match its frozen allowlist`);
  }
  const trustedApplicationOrigins = Array.from(
    new Set([...trustedStorefrontOrigins, ...trustedAdminOrigins]),
  );

  const betterAuthUrl = exactOrigin("BETTER_AUTH_URL");
  const jwtIssuer = exactOrigin("AUTH_JWT_ISSUER");
  if (betterAuthUrl !== jwtIssuer) {
    throw new Error(
      "AUTH_JWT_ISSUER must equal the static BETTER_AUTH_URL authority",
    );
  }
  const jwtAudience = exactOrigin("AUTH_JWT_AUDIENCE");
  const frozenAuthority =
    environment === "production"
      ? {
          auth: PRODUCTION_AUTH_ORIGIN,
          api: PRODUCTION_API_AUDIENCE,
        }
      : environment === "staging"
        ? { auth: STAGING_AUTH_ORIGIN, api: STAGING_API_AUDIENCE }
        : null;
  if (
    frozenAuthority &&
    (betterAuthUrl !== frozenAuthority.auth ||
      jwtAudience !== frozenAuthority.api)
  ) {
    throw new Error(
      `${environment} Better Auth issuer and Strapi audience must match the frozen authorities`,
    );
  }

  const jwtTtlSeconds = exactInteger("AUTH_JWT_TTL_SECONDS", 60) as 60;

  cached = Object.freeze({
    nodeEnv,
    deploymentEnvironment: environment,
    betterAuthUrl,
    betterAuthSecret: strongSecret("BETTER_AUTH_SECRET"),
    databaseUrl: required("AUTH_DATABASE_URL"),
    flowSecret: strongSecret("AUTH_FLOW_SECRET"),
    trustedStorefrontOrigins,
    trustedAdminOrigins,
    trustedApplicationOrigins,
    defaultStorefrontOrigin,
    strapiInternalUrl: serviceOrigin("STRAPI_INTERNAL_URL"),
    bridgeSecret: strongSecret("AUTH_STRAPI_BRIDGE_SECRET"),
    jwtIssuer,
    jwtAudience,
    jwtTtlSeconds,
    // Better Auth treats a numeric expirationTime as an absolute NumericDate.
    // The duration string is required for a lifetime relative to issuance.
    jwtExpirationTime: `${jwtTtlSeconds}s` as "60s",
    jwksRotationSeconds: exactInteger(
      "AUTH_JWKS_ROTATION_SECONDS",
      2_592_000,
    ) as 2_592_000,
    jwksGraceSeconds: exactInteger("AUTH_JWKS_GRACE_SECONDS", 86_400) as 86_400,
    sessionTtlSeconds: exactInteger(
      "AUTH_SESSION_TTL_SECONDS",
      604_800,
    ) as 604_800,
  });
  return cached;
}

export function resetAuthEnvForTests(): void {
  cached = undefined;
}
