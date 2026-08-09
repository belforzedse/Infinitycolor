export type AdminEnvironment = "development" | "e2e" | "staging" | "production";

const FROZEN_ADMIN_ORIGINS: Record<Exclude<AdminEnvironment, "development">, string> = {
  e2e: "http://localhost:2891",
  staging: "https://admin.staging.infinitycolor.co",
  production: "https://admin.infinitycolor.co",
};

const FROZEN_STOREFRONT_ORIGINS: Record<Exclude<AdminEnvironment, "development">, string> = {
  e2e: "http://localhost:2888",
  staging: "https://staging.infinitycolor.co",
  production: "https://new.infinitycolor.co",
};

const FROZEN_API_URLS: Record<Exclude<AdminEnvironment, "development">, string> = {
  e2e: "http://localhost:2891/api/backend",
  staging: "https://api.staging.infinitycolor.co/api",
  production: "https://api.infinitycolor.co/api",
};

export function adminEnvironment(): AdminEnvironment {
  const value = process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT?.trim();
  if (!value) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("NEXT_PUBLIC_ADMIN_ENVIRONMENT is required in production mode");
    }
    return "development";
  }
  if (!["development", "e2e", "staging", "production"].includes(value)) {
    throw new Error("NEXT_PUBLIC_ADMIN_ENVIRONMENT must be development, e2e, staging, or production");
  }
  if (process.env.NODE_ENV === "production" && value === "development") {
    throw new Error("A production admin build cannot use the development environment");
  }
  return value as AdminEnvironment;
}

export function exactHttpOrigin(name: string, raw: string): string {
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

function isLoopbackOrigin(origin: string): boolean {
  const hostname = new URL(origin).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function validateFrozenOrigin(
  name: string,
  origin: string,
  frozen: Record<Exclude<AdminEnvironment, "development">, string>,
): string {
  const environment = adminEnvironment();
  if (environment === "e2e" && isLoopbackOrigin(origin)) return origin;
  if (environment !== "development" && origin !== frozen[environment]) {
    throw new Error(`${name} must match the frozen ${environment} authority`);
  }
  return origin;
}

function frozenOrigin(
  name: string,
  configured: string | undefined,
  frozen: Record<Exclude<AdminEnvironment, "development">, string>,
  developmentFallback: string,
): string {
  const environment = adminEnvironment();
  if (!configured?.trim()) {
    if (environment !== "development") throw new Error(`${name} is required outside development`);
    return developmentFallback;
  }
  const origin = exactHttpOrigin(name, configured.trim());
  return validateFrozenOrigin(name, origin, frozen);
}

export function adminOrigin(): string {
  return frozenOrigin(
    "ADMIN_URL",
    process.env.ADMIN_URL || process.env.NEXT_PUBLIC_ADMIN_URL,
    FROZEN_ADMIN_ORIGINS,
    "http://localhost:2891",
  );
}

export function storefrontOrigin(): string {
  return frozenOrigin(
    "NEXT_PUBLIC_STOREFRONT_URL",
    process.env.NEXT_PUBLIC_STOREFRONT_URL,
    FROZEN_STOREFRONT_ORIGINS,
    "http://localhost:2888",
  );
}

export function adminRelease(): string {
  return process.env.RELEASE_SHA?.trim() || process.env.NEXT_PUBLIC_RELEASE_SHA?.trim() || "development";
}

function canonicalValue(name: string, canonical: string | undefined, legacy?: string): string | undefined {
  const canonicalValue = canonical?.trim();
  const legacyValue = legacy?.trim();
  if (canonicalValue && legacyValue && canonicalValue !== legacyValue) {
    throw new Error(`${name} and its compatibility alias must match exactly`);
  }
  if (adminEnvironment() !== "development" && !canonicalValue) {
    throw new Error(`${name} is required outside development`);
  }
  return canonicalValue || legacyValue;
}

export function adminApiUrl(): string {
  const raw = canonicalValue(
    "NEXT_PUBLIC_API_URL",
    process.env.NEXT_PUBLIC_API_URL,
    process.env.NEXT_PUBLIC_API_BASE_URL,
  );
  if (!raw) return "http://127.0.0.1:1337/api";
  const environment = adminEnvironment();
  const requiredPath = environment === "e2e" ? "/api/backend" : "/api";
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/$/, "") !== requiredPath
  ) {
    throw new Error(
      `NEXT_PUBLIC_API_URL must be an HTTP(S) URL ending exactly in ${requiredPath}`,
    );
  }
  const normalized = `${url.origin}${requiredPath}`;
  if (environment === "e2e" && isLoopbackOrigin(url.origin)) return normalized;
  if (environment !== "development" && normalized !== FROZEN_API_URLS[environment]) {
    throw new Error(`NEXT_PUBLIC_API_URL must match the frozen ${environment} API URL`);
  }
  return normalized;
}

export function validateAdminAnalyticsProvisioning(): void {
  const environment = adminEnvironment();
  const rawUrl = process.env.NEXT_PUBLIC_ADMIN_MATOMO_URL?.trim();
  const siteId = process.env.NEXT_PUBLIC_ADMIN_MATOMO_SITE_ID?.trim();
  if (!rawUrl || !siteId) {
    if (environment === "staging" || environment === "production") {
      throw new Error("Dedicated admin Matomo URL and site id are required before deployment verification");
    }
    return;
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("NEXT_PUBLIC_ADMIN_MATOMO_URL must be a credential-free HTTPS URL");
  }
  if (!/^\d+$/.test(siteId)) {
    throw new Error("NEXT_PUBLIC_ADMIN_MATOMO_SITE_ID must be a numeric, admin-specific site id");
  }
}

export function validateAdminRuntimeConfiguration(): void {
  const admin = adminOrigin();
  const storefront = storefrontOrigin();
  adminApiUrl();
  if (admin === storefront) {
    throw new Error("ADMIN_URL and NEXT_PUBLIC_STOREFRONT_URL must be distinct origins");
  }
}
