export type CentralAuthEnvironment = "development" | "staging" | "production";

const FROZEN_AUTH_ORIGINS: Record<Exclude<CentralAuthEnvironment, "development">, string> = {
  staging: "https://auth.staging.infinitycolor.co",
  production: "https://auth.infinitycolor.co",
};

export function centralAuthEnvironment(): CentralAuthEnvironment {
  const value = process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT?.trim();
  if (!value) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("NEXT_PUBLIC_AUTH_ENVIRONMENT is required in production mode");
    }
    return "development";
  }
  if (value !== "development" && value !== "staging" && value !== "production") {
    throw new Error("NEXT_PUBLIC_AUTH_ENVIRONMENT must be development, staging, or production");
  }
  if (process.env.NODE_ENV === "production" && value === "development") {
    throw new Error("A production storefront build cannot use the development auth environment");
  }
  return value;
}

export function exactCentralAuthOrigin(): string {
  const environment = centralAuthEnvironment();
  const configured = process.env.NEXT_PUBLIC_AUTH_ORIGIN?.trim();
  if (!configured) {
    if (environment !== "development") {
      throw new Error("NEXT_PUBLIC_AUTH_ORIGIN is required outside development");
    }
    return "http://localhost:2889";
  }
  const url = new URL(configured);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("NEXT_PUBLIC_AUTH_ORIGIN must be an exact HTTP(S) origin");
  }
  if (environment !== "development" && url.origin !== FROZEN_AUTH_ORIGINS[environment]) {
    throw new Error(`${environment} central auth origin must match its frozen authority`);
  }
  return url.origin;
}
