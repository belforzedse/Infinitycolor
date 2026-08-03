import { timingSafeEqual } from "node:crypto";

export const WORDPRESS_MIGRATION_MODE = "wordpress-v2";
export const WORDPRESS_SOURCE_CREATED_AT_HEADER = "x-infinity-source-created-at";
export const WORDPRESS_SOURCE_UPDATED_AT_HEADER = "x-infinity-source-updated-at";

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

export type WordPressMigrationSourceTimestamps = {
  createdAt: Date;
  updatedAt: Date;
};

const parseCanonicalTimestamp = (value: string, code: string): Date => {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(code);
  }
  return parsed;
};

/**
 * Source timestamps are accepted only on a fully trusted migration request. Both
 * values are required and must be canonical UTC ISO strings so a partial or
 * timezone-ambiguous request fails instead of silently stamping import time.
 */
export function getTrustedWordPressMigrationSourceTimestamps():
  WordPressMigrationSourceTimestamps | null {
  if (!isTrustedWordPressMigrationRequest()) return null;

  const requestCtx = (global as any)?.strapi?.requestContext?.get?.();
  const headers = requestCtx?.request?.headers || requestCtx?.headers;
  const rawCreatedAt = readHeader(headers, WORDPRESS_SOURCE_CREATED_AT_HEADER);
  const rawUpdatedAt = readHeader(headers, WORDPRESS_SOURCE_UPDATED_AT_HEADER);
  if (!rawCreatedAt && !rawUpdatedAt) return null;
  if (!rawCreatedAt || !rawUpdatedAt) {
    throw new Error("MIGRATION_SOURCE_TIMESTAMPS_INCOMPLETE");
  }

  const createdAt = parseCanonicalTimestamp(rawCreatedAt, "MIGRATION_SOURCE_CREATED_AT_INVALID");
  const updatedAt = parseCanonicalTimestamp(rawUpdatedAt, "MIGRATION_SOURCE_UPDATED_AT_INVALID");
  if (updatedAt.getTime() < createdAt.getTime()) {
    throw new Error("MIGRATION_SOURCE_UPDATED_BEFORE_CREATED");
  }
  return { createdAt, updatedAt };
}
