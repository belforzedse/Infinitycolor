/**
 * Hard safety guards for the integration test layer.
 *
 * These tests run a REAL database with REAL writes. The only acceptable
 * target is an ephemeral, test-owned Postgres. If anything about the
 * environment looks like staging/production we abort loudly BEFORE Strapi
 * connects — never risk pointing the suite at real data.
 */
import type { IntegrationDbConnection } from "./env";

/** Hostnames / DB names that must never be touched by tests. */
const FORBIDDEN_HOST_SUBSTRINGS = ["infinity-postgres", "infinity.rgbgroup", "rgbgroup.ir", "arvan"];
const FORBIDDEN_DB_NAMES = ["prod", "production", "dev", "staging", "infinity_db", "infinity"];

const looksLikeLoopbackHost = (host: string) => {
  const h = host.trim().toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "0.0.0.0" ||
    h === "host.docker.internal" ||
    // Docker bridge / private container IPs are acceptable for a disposable container.
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h)
  );
};

export function assertSafeIntegrationTarget(conn: IntegrationDbConnection): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      `[integration-safety] NODE_ENV must be "test" to run integration tests (got "${process.env.NODE_ENV}").`,
    );
  }

  const host = String(conn.host || "").toLowerCase();
  const database = String(conn.database || "").toLowerCase();

  for (const bad of FORBIDDEN_HOST_SUBSTRINGS) {
    if (host.includes(bad)) {
      throw new Error(
        `[integration-safety] Refusing to run: DB host "${conn.host}" looks like a real environment (matched "${bad}").`,
      );
    }
  }

  if (FORBIDDEN_DB_NAMES.includes(database)) {
    throw new Error(
      `[integration-safety] Refusing to run: DB name "${conn.database}" looks like a real environment.`,
    );
  }

  if (!looksLikeLoopbackHost(host)) {
    throw new Error(
      `[integration-safety] Refusing to run: DB host "${conn.host}" is not a local/container address. ` +
        `Integration tests only run against a disposable, test-owned Postgres.`,
    );
  }
}
