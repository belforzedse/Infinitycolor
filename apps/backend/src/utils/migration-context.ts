import { timingSafeEqual } from "node:crypto";

export const WORDPRESS_MIGRATION_MODE = "wordpress-v2";

const readHeader = (headers: Record<string, unknown> | undefined, name: string): string => {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
};

const safeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
};

/**
 * Migration side-effect suppression is fail-closed: the request must carry the
 * expected mode and a separately configured control token. A Strapi API token
 * alone cannot opt ordinary writes out of auditing/revalidation.
 */
export function isTrustedWordPressMigrationRequest(): boolean {
  const controlToken = String(process.env.MIGRATION_CONTROL_TOKEN || "");
  if (controlToken.length < 32) return false;

  const requestCtx = (global as any)?.strapi?.requestContext?.get?.();
  const headers = requestCtx?.request?.headers || requestCtx?.headers;
  const mode = readHeader(headers, "x-infinity-migration-mode");
  const suppliedToken = readHeader(headers, "x-infinity-migration-control");

  return mode === WORDPRESS_MIGRATION_MODE && safeEqual(suppliedToken, controlToken);
}
