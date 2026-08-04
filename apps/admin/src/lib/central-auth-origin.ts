export type CentralAuthEnvironment =
  | "development"
  | "e2e"
  | "staging"
  | "production";

const FROZEN_AUTH_ORIGINS: Record<
  Exclude<CentralAuthEnvironment, "development">,
  string
> = {
  e2e: "http://localhost:2889",
  staging: "https://auth.staging.infinitycolor.co",
  production: "https://auth.infinitycolor.co",
};

function isLoopbackOrigin(origin: string): boolean {
  const hostname = new URL(origin).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function centralAuthEnvironment(): CentralAuthEnvironment {
  const value = process.env.NEXT_PUBLIC_AUTH_ENVIRONMENT?.trim();
  if (!value) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("NEXT_PUBLIC_AUTH_ENVIRONMENT is required in production mode");
    }
    return "development";
  }
  if (
    value !== "development" &&
    value !== "e2e" &&
    value !== "staging" &&
    value !== "production"
  ) {
    throw new Error(
      "NEXT_PUBLIC_AUTH_ENVIRONMENT must be development, e2e, staging, or production",
    );
  }
  if (process.env.NODE_ENV === "production" && value === "development") {
      throw new Error("A production admin build cannot use the development auth environment");
  }
  return value;
}

export function exactCentralAuthOrigin(): string {
  const environment = centralAuthEnvironment();
  const canonical = process.env.NEXT_PUBLIC_AUTH_URL?.trim();
  const compatibility = process.env.NEXT_PUBLIC_AUTH_ORIGIN?.trim();
  if (canonical && compatibility && canonical !== compatibility) {
    throw new Error("NEXT_PUBLIC_AUTH_URL and NEXT_PUBLIC_AUTH_ORIGIN must match exactly");
  }
  if (environment !== "development" && !canonical) {
    throw new Error("NEXT_PUBLIC_AUTH_URL is required outside development");
  }
  const configured = canonical || compatibility;
  if (!configured) {
    if (environment !== "development") {
      throw new Error("NEXT_PUBLIC_AUTH_URL is required outside development");
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
    throw new Error("NEXT_PUBLIC_AUTH_URL must be an exact HTTP(S) origin");
  }
  if (
    environment !== "development" &&
    !(environment === "e2e" && isLoopbackOrigin(url.origin)) &&
    url.origin !== FROZEN_AUTH_ORIGINS[environment]
  ) {
    throw new Error(`${environment} central auth origin must match its frozen authority`);
  }
  return url.origin;
}
