import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyOptions } from "jose";
import { errors as strapiErrors } from "@strapi/utils";
import { MANAGEMENT_ROLES, normalizeRoleName } from "../utils/roles";

const { ForbiddenError, UnauthorizedError } = strapiErrors;
const MAX_TOKEN_TTL_SECONDS = 60;
const JWKS_TIMEOUT_MS = 5_000;
const FORCED_REFRESH_MIN_INTERVAL_MS = 1_000;
const PRODUCTION_AUTH_ORIGIN = "https://auth.infinitycolor.co";
const PRODUCTION_API_AUDIENCE = "https://api.infinitycolor.co";
const PRODUCTION_JWKS_URL = "https://auth.infinitycolor.co/api/auth/jwks";
const STAGING_AUTH_ORIGIN = "https://auth.staging.infinitycolor.co";
const STAGING_API_AUDIENCE = "https://api.staging.infinitycolor.co";
const STAGING_JWKS_URL = "https://auth.staging.infinitycolor.co/api/auth/jwks";
const PROFILE_COMPLETION_PATHS = new Set([
  "/api/auth/self",
  "/auth/self",
  "/api/auth/register-info",
  "/auth/register-info",
]);

interface BetterAuthJwtConfig {
  jwksUrl: URL;
  issuer: string;
  audience: string;
  clockToleranceSeconds: number;
}

let remoteJwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let remoteJwksUrl: string | undefined;
let lastForcedRefreshAt = 0;

function exactOrigin(name: string, value: string): string {
  const url = new URL(value);
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

function configuredEnvironment(): "development" | "e2e" | "staging" | "production" {
  const value = process.env.BETTER_AUTH_ENVIRONMENT?.trim();
  if (!value) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "BETTER_AUTH_ENVIRONMENT is required when the bridge runs in production mode",
      );
    }
    return "development";
  }
  if (value !== "development" && value !== "e2e" && value !== "staging" && value !== "production") {
    throw new Error("BETTER_AUTH_ENVIRONMENT must be development, e2e, staging, or production");
  }
  if (
    value === "e2e" &&
    (process.env.GITLAB_CI !== "true" || process.env.CI_PROJECT_PATH !== "bel4/infinity")
  ) {
    throw new Error(
      "The e2e Better Auth environment is restricted to the Infinity GitLab CI project",
    );
  }
  if (process.env.NODE_ENV === "production" && value === "development") {
    throw new Error(
      "A production Strapi process cannot use the development Better Auth environment",
    );
  }
  return value;
}

function getConfig(): BetterAuthJwtConfig | null {
  if (process.env.BETTER_AUTH_BRIDGE_ENABLED !== "true") return null;
  const jwksRaw = process.env.BETTER_AUTH_JWKS_URL?.trim();
  const issuerRaw = process.env.BETTER_AUTH_JWT_ISSUER?.trim();
  const audienceRaw = process.env.BETTER_AUTH_JWT_AUDIENCE?.trim();
  if (!jwksRaw || !issuerRaw || !audienceRaw) {
    throw new Error(
      "Better Auth JWT strategy is enabled but its JWKS/issuer/audience is incomplete",
    );
  }
  const jwksUrl = new URL(jwksRaw);
  const environment = configuredEnvironment();
  if (
    !["http:", "https:"].includes(jwksUrl.protocol) ||
    jwksUrl.username ||
    jwksUrl.password ||
    jwksUrl.search ||
    jwksUrl.hash
  ) {
    throw new Error("BETTER_AUTH_JWKS_URL must be an HTTP(S) URL without credentials");
  }
  const tolerance = Number(process.env.BETTER_AUTH_JWT_CLOCK_TOLERANCE_SECONDS ?? "5");
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 10) {
    throw new Error("BETTER_AUTH_JWT_CLOCK_TOLERANCE_SECONDS must be an integer from 0 to 10");
  }
  const issuer = exactOrigin("BETTER_AUTH_JWT_ISSUER", issuerRaw);
  const audience = exactOrigin("BETTER_AUTH_JWT_AUDIENCE", audienceRaw);
  const frozenAuthority =
    environment === "production"
      ? {
          auth: PRODUCTION_AUTH_ORIGIN,
          api: PRODUCTION_API_AUDIENCE,
          jwks: PRODUCTION_JWKS_URL,
        }
      : environment === "staging"
      ? {
          auth: STAGING_AUTH_ORIGIN,
          api: STAGING_API_AUDIENCE,
          jwks: STAGING_JWKS_URL,
        }
      : environment === "e2e"
      ? {
          auth: "http://localhost:2889",
          api: "http://backend:1337",
          jwks: "http://build:2889/api/auth/jwks",
        }
      : null;
  if (
    frozenAuthority &&
    (issuer !== frozenAuthority.auth ||
      audience !== frozenAuthority.api ||
      jwksUrl.href !== frozenAuthority.jwks)
  ) {
    throw new Error(
      `${environment} Better Auth JWKS, issuer, and audience must match the frozen authorities`,
    );
  }
  return {
    jwksUrl,
    issuer,
    audience,
    clockToleranceSeconds: tolerance,
  };
}

function createJwksResolver(url: URL) {
  return createRemoteJWKSet(url, {
    timeoutDuration: JWKS_TIMEOUT_MS,
    cooldownDuration: 30_000,
    cacheMaxAge: 5 * 60_000,
    headers: { accept: "application/json" },
  });
}

function getJwksResolver(config: BetterAuthJwtConfig) {
  if (!remoteJwks || remoteJwksUrl !== config.jwksUrl.href) {
    remoteJwks = createJwksResolver(config.jwksUrl);
    remoteJwksUrl = config.jwksUrl.href;
  }
  return remoteJwks;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "JWT_REJECTED")
    : "JWT_REJECTED";
}

function isJwksInfrastructureError(error: unknown): boolean {
  const code = errorCode(error);
  if (
    code === "ERR_JWKS_TIMEOUT" ||
    code === "ERR_JWKS_INVALID" ||
    code === "ERR_JWKS_MULTIPLE_MATCHING_KEYS" ||
    code === "ERR_JOSE_GENERIC"
  ) {
    return true;
  }
  if (error instanceof TypeError) return true;
  if (typeof error !== "object" || error === null || !("cause" in error)) return false;
  return isJwksInfrastructureError((error as { cause?: unknown }).cause);
}

async function verifyJwtWithRefresh(token: string, config: BetterAuthJwtConfig) {
  const verification: JWTVerifyOptions = {
    algorithms: ["EdDSA"],
    issuer: config.issuer,
    audience: config.audience,
    clockTolerance: config.clockToleranceSeconds,
    requiredClaims: ["iss", "aud", "sub", "exp", "iat", "nbf", "jti", "sid", "strapi_user_id"],
  };
  try {
    return await jwtVerify(token, getJwksResolver(config), verification);
  } catch (error) {
    if (errorCode(error) !== "ERR_JWKS_NO_MATCHING_KEY") throw error;
    const now = Date.now();
    if (now - lastForcedRefreshAt < FORCED_REFRESH_MIN_INTERVAL_MS) throw error;
    lastForcedRefreshAt = now;
    remoteJwks = createJwksResolver(config.jwksUrl);
    return jwtVerify(token, remoteJwks, verification);
  }
}

function bearerToken(ctx: any): string | null {
  const header = String(ctx.request?.header?.authorization ?? "");
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}

function numericStrapiUserId(payload: JWTPayload): number | null {
  const raw = payload.strapi_user_id;
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : null;
}

function hasExactAuthorityClaims(payload: JWTPayload, issuer: string, audience: string): boolean {
  return payload.iss === issuer && payload.aud === audience;
}

function validatePinnedClaims(
  payload: JWTPayload,
  protectedHeader: { alg?: string; kid?: string },
  nowSeconds = Math.floor(Date.now() / 1_000),
): number | null {
  if (
    protectedHeader.alg !== "EdDSA" ||
    typeof protectedHeader.kid !== "string" ||
    !protectedHeader.kid
  ) {
    return null;
  }
  if (
    typeof payload.sub !== "string" ||
    payload.sub.length < 1 ||
    payload.sub.length > 128 ||
    typeof payload.sid !== "string" ||
    payload.sid.length < 1 ||
    payload.sid.length > 128 ||
    typeof payload.jti !== "string" ||
    payload.jti.length < 8 ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    typeof payload.nbf !== "number" ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > MAX_TOKEN_TTL_SECONDS ||
    // jose's small clock tolerance is useful for nbf/clock skew, but must not
    // extend the frozen 60-second post-logout/reset residual-validity bound.
    payload.exp <= nowSeconds ||
    payload.nbf > payload.iat
  ) {
    return null;
  }
  return numericStrapiUserId(payload);
}

function hasRequiredProfileNames(profile: unknown): boolean {
  if (!profile || typeof profile !== "object") return false;
  const value = profile as { FirstName?: unknown; LastName?: unknown };
  return (
    typeof value.FirstName === "string" &&
    value.FirstName.trim().length > 0 &&
    typeof value.LastName === "string" &&
    value.LastName.trim().length > 0
  );
}

function isManagementRole(roleName: unknown): boolean {
  const normalized = normalizeRoleName(typeof roleName === "string" ? roleName : null);
  return normalized
    ? MANAGEMENT_ROLES.includes(normalized as (typeof MANAGEMENT_ROLES)[number])
    : false;
}

async function advancedSettings() {
  return strapi
    .store({ type: "plugin", name: "users-permissions" })
    .get({ key: "advanced" }) as Promise<{
    email_confirmation?: boolean;
  }>;
}

async function authenticate(ctx: any) {
  const token = bearerToken(ctx);
  if (!token || token.split(".").length !== 3) return { authenticated: false };

  let config: BetterAuthJwtConfig | null;
  try {
    config = getConfig();
  } catch (error) {
    strapi.log.error("Better Auth JWT configuration unavailable", {
      reasonCode: errorCode(error),
    });
    ctx.set("Retry-After", "1");
    ctx.throw(503, "Authentication service temporarily unavailable");
  }
  if (!config) return { authenticated: false };

  let verified: Awaited<ReturnType<typeof verifyJwtWithRefresh>>;
  try {
    verified = await verifyJwtWithRefresh(token, config);
  } catch (error) {
    const reasonCode = errorCode(error);
    if (isJwksInfrastructureError(error)) {
      strapi.log.warn("Better Auth JWKS unavailable", {
        reasonCode,
        processRole: process.env.PROCESS_ROLE ?? "web",
      });
      ctx.set("Retry-After", "1");
      ctx.throw(503, "Authentication service temporarily unavailable");
    }
    strapi.log.debug("Better Auth JWT rejected", { reasonCode });
    return { authenticated: false };
  }

  const { payload, protectedHeader } = verified;
  if (!hasExactAuthorityClaims(payload, config.issuer, config.audience)) {
    return { authenticated: false };
  }
  const userId = validatePinnedClaims(payload, protectedHeader);
  if (!userId) return { authenticated: false };

  const usersPermissions = strapi.plugin("users-permissions");
  const user = await usersPermissions.service("user").fetchAuthenticatedUser(userId);
  if (!user?.role?.id) return { error: "Invalid credentials" };
  const settings = await advancedSettings();
  if (settings.email_confirmation && !user.confirmed) return { error: "Invalid credentials" };
  if (user.blocked) return { error: "Invalid credentials" };

  // A provisional OTP identity may exist before the user submits their name.
  // It may call only the profile read/completion endpoints until both required
  // fields are present. Management accounts retain the existing role behavior.
  if (!isManagementRole(user.role.name)) {
    const profile = await strapi.db.query("api::local-user-info.local-user-info").findOne({
      where: { user: user.id },
      select: ["FirstName", "LastName"],
    });
    if (!hasRequiredProfileNames(profile) && !PROFILE_COMPLETION_PATHS.has(ctx.request.path)) {
      return { error: "Profile completion required" };
    }
  }

  const permissionService = usersPermissions.service("permission");
  const permissions = (await permissionService.findRolePermissions(user.role.id)).map(
    (permission) => permissionService.toContentAPIPermission(permission),
  );
  const ability = await strapi.contentAPI.permissions.engine.generateAbility(permissions);
  ctx.state.user = user;
  ctx.state.betterAuthSessionId = payload.sid;
  return { authenticated: true, credentials: user, ability };
}

async function verify(auth: any, config: any) {
  const { credentials: user, ability } = auth;
  if (!config.scope) {
    if (!user) throw new UnauthorizedError();
    return;
  }
  if (!ability) throw new UnauthorizedError();
  const scopes = Array.isArray(config.scope) ? config.scope : [config.scope];
  if (!scopes.every((scope) => ability.can(scope))) throw new ForbiddenError();
}

export const betterAuthJwtStrategy = {
  name: "better-auth-jwt",
  authenticate,
  verify,
};

export const __betterAuthJwtTestUtils = {
  getConfig,
  numericStrapiUserId,
  validatePinnedClaims,
  hasExactAuthorityClaims,
  hasRequiredProfileNames,
  isManagementRole,
  isJwksInfrastructureError,
  resetJwks() {
    remoteJwks = undefined;
    remoteJwksUrl = undefined;
    lastForcedRefreshAt = 0;
  },
};
