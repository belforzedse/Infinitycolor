import type { Context } from "koa";

/**
 * Centralized client-IP / user-agent extraction for audit logging.
 *
 * Why this exists: Koa's `ctx.request.ip` returns the *immediate peer* (the nginx→Strapi hop or the
 * Docker bridge gateway, e.g. `172.26.0.1`) unless `app.proxy = true` (set via `config/server.ts`
 * `proxy: true`). Several call sites historically read `ctx.request.ip` first and so stored the
 * container IP as if it were the real user IP. This helper is the single source of truth and reads
 * the trusted proxy headers nginx forwards (`X-Real-IP`, `X-Forwarded-For`) before falling back.
 *
 * Trust model: the deployment always sits behind nginx (a trusted proxy) which sets these headers
 * from `$remote_addr`. We therefore trust them. If the topology ever changes, disable proxy trust
 * via the `IS_PROXIED` env var. `cf-connecting-ip` is read defensively in case Cloudflare is ever
 * placed in front, but nginx-only deployments never set it.
 */

const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// Loose IPv6 validation: hex groups and `:` only (plus optional `%zone`). Good enough to reject
// garbage headers without rejecting valid addresses.
const IPV6_REGEX = /^[0-9a-fA-F:]+(%[0-9a-zA-Z]+)?$/;

/** Strip an IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4` → `1.2.3.4`). */
function unmapIpv4(ip: string): string {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const tail = ip.slice(7);
    if (IPV4_REGEX.test(tail)) return tail;
  }
  return ip;
}

/** Basic sanity check that a string looks like an IPv4 or IPv6 address. */
function isValidIp(ip: string): boolean {
  if (!ip) return false;
  if (IPV4_REGEX.test(ip)) {
    return ip.split(".").every((octet) => Number(octet) <= 255);
  }
  // Require at least one colon to be considered IPv6 (avoids matching bare numbers/words).
  return ip.includes(":") && IPV6_REGEX.test(ip);
}

/**
 * Private / loopback / link-local / unique-local ranges. A misleading container IP should never be
 * preferred over a real forwarded address — used to pick the first *public* entry from a list.
 */
export function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  const normalized = unmapIpv4(ip).toLowerCase();

  if (IPV4_REGEX.test(normalized)) {
    const [a, b] = normalized.split(".").map(Number);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }

  // IPv6
  if (normalized === "::1") return true; // loopback
  if (normalized.startsWith("fe80")) return true; // link-local
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7 ULA
  return false;
}

/** Normalize and validate a raw IP candidate; returns null if it isn't a usable address. */
function clean(candidate: unknown): string | null {
  if (typeof candidate !== "string") return null;
  const trimmed = unmapIpv4(candidate.trim());
  if (!trimmed) return null;
  return isValidIp(trimmed) ? trimmed : null;
}

function header(ctx: Context, name: string): string | null {
  const value = ctx?.request?.header?.[name] ?? ctx?.request?.headers?.[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

/**
 * Resolve the real client IP from a Koa context.
 *
 * Priority: `cf-connecting-ip` → `x-real-ip` → first public entry of `x-forwarded-for`
 * (else its leftmost entry) → Koa `ctx.request.ip` / `ctx.request.ips[0]`.
 * Returns `null` when nothing usable is present (callers store `null` rather than a misleading IP).
 */
export function getClientIp(ctx: Context | null | undefined): string | null {
  if (!ctx) return null;

  // 1) Cloudflare (defensive — unset on nginx-only deployments).
  const cf = clean(header(ctx, "cf-connecting-ip"));
  if (cf) return cf;

  // 2) nginx `X-Real-IP` ($remote_addr) — the direct client of the trusted proxy.
  const real = clean(header(ctx, "x-real-ip"));
  if (real) return real;

  // 3) X-Forwarded-For: client, proxy1, proxy2 … Prefer the first *public* address; if every entry
  //    is private (all-internal hop chain), fall back to the leftmost.
  const xff = header(ctx, "x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((p) => clean(p))
      .filter((p): p is string => !!p);
    const publicHit = parts.find((p) => !isPrivateIp(p));
    if (publicHit) return publicHit;
    if (parts.length > 0) return parts[0];
  }

  // 4) Koa's parsed value (proxy-aware once `app.proxy = true`).
  const koaIps = (ctx.request as any)?.ips as string[] | undefined;
  if (Array.isArray(koaIps) && koaIps.length > 0) {
    const fromKoa = clean(koaIps[0]);
    if (fromKoa) return fromKoa;
  }
  return clean(ctx.request?.ip);
}

// Several audit log tables (contract_logs.user_agent, admin_activities.user_agent, …) store
// this in a `varchar(255)` column. An oversized/malformed header (seen in prod on 2026-09-14,
// repeatedly failing checkout with CONTRACT_CREATION_FAILED) must not reach the insert unclipped.
const MAX_USER_AGENT_LENGTH = 255;

/** Extract the request User-Agent (deduped across call sites), clipped to fit varchar(255) audit columns. */
export function getUserAgent(ctx: Context | null | undefined): string | null {
  if (!ctx) return null;
  const value = header(ctx, "user-agent");
  return value ? value.slice(0, MAX_USER_AGENT_LENGTH) : null;
}
