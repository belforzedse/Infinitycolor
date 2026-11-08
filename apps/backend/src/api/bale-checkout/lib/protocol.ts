import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const BALE_CHECKOUT_TTL_MS = 60 * 60 * 1_000;
const MAX_ITEMS = 20;
const MAX_QUANTITY = 100;
const MAX_INVENTORY_KEYS = 50;
const MAX_VARIATION_ID = 2_147_483_647;

export type BaleItem = { variationId: number; quantity: number };
export type InventoryLookup = { ids: number[] } | { skus: string[] };

export class BaleApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function invalid(message: string): never {
  throw new BaleApiError(400, "BALE_INVALID_REQUEST", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isVariationId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_VARIATION_ID;
}

export function parseInventoryLookup(value: unknown): InventoryLookup {
  if (!isObject(value) || Object.keys(value).length !== 1) {
    invalid("Supply either ids or skus.");
  }
  const byId = Object.prototype.hasOwnProperty.call(value, "ids");
  const input = byId ? value.ids : value.skus;
  if (typeof input !== "string" || input.length > MAX_INVENTORY_KEYS * 129) {
    invalid("Supply a comma-separated list of ids or skus.");
  }
  const keys = input.split(",").map((key) => key.trim());
  if (keys.length > MAX_INVENTORY_KEYS || keys.some((key) => !key)) {
    invalid("Supply between 1 and 50 ids or skus.");
  }
  if (byId) {
    const ids = keys.map((key) => /^[1-9][0-9]{0,9}$/.test(key) ? Number(key) : 0);
    if (!ids.every(isVariationId)) invalid("Each variation ID must be a positive integer.");
    return { ids: Array.from(new Set(ids)) };
  }
  if (keys.some((sku) => sku.length > 128 || /[\u0000-\u001f\u007f]/.test(sku))) {
    invalid("Each SKU must be at most 128 characters.");
  }
  return { skus: Array.from(new Set(keys)) };
}

export function parseBaleItems(body: unknown): BaleItem[] {
  if (
    !isObject(body) || Object.keys(body).length !== 1 || !Array.isArray(body.items) ||
    body.items.length < 1 || body.items.length > MAX_ITEMS
  ) {
    invalid("Supply between 1 and 20 items.");
  }
  const items = new Map<number, number>();
  for (const line of body.items) {
    if (
      !isObject(line) || Object.keys(line).length !== 2 || !isVariationId(line.variationId) ||
      typeof line.quantity !== "number" || !Number.isInteger(line.quantity) ||
      line.quantity < 1 || line.quantity > MAX_QUANTITY
    ) {
      invalid("Each item needs a positive variationId and a quantity between 1 and 100.");
    }
    const quantity = (items.get(line.variationId) ?? 0) + line.quantity;
    if (quantity > MAX_QUANTITY) invalid("Order up to 100 of each item.");
    items.set(line.variationId, quantity);
  }
  return [...items].sort(([a], [b]) => a - b).map(([variationId, quantity]) => ({
    variationId,
    quantity,
  }));
}

export function requireOpaqueHeader(value: string, name: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) invalid(`Supply a valid ${name} header.`);
  return value;
}

export function isCheckoutId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function checkoutNotFound(): BaleApiError {
  return new BaleApiError(404, "BALE_CHECKOUT_NOT_FOUND", "Checkout not found.");
}

export function checkoutExpired(): BaleApiError {
  return new BaleApiError(410, "BALE_CHECKOUT_EXPIRED", "This checkout link has expired.");
}

export function baleUnavailable(): BaleApiError {
  return new BaleApiError(503, "BALE_UNAVAILABLE", "Checkout is temporarily unavailable.");
}

export function hashBaleValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function equalSecret(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );
}

export function requireBotToken(authorization: string): void {
  const expected = process.env.BALE_BOT_API_TOKEN?.trim();
  const supplied = /^Bearer ([^\s,]+)$/i.exec(authorization)?.[1];
  if (!expected) throw baleUnavailable();
  if (!supplied || !equalSecret(supplied, expected)) {
    throw new BaleApiError(401, "BALE_UNAUTHORIZED", "A valid bot credential is required.");
  }
}

function checkoutGrant(checkoutId: string): string {
  const secret = process.env.BALE_CHECKOUT_GRANT_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret) < 32) throw baleUnavailable();
  return createHmac("sha256", secret)
    .update(`infinitycolor:bale-checkout:grant:v1:${checkoutId}`)
    .digest("base64url");
}

export function verifyCheckoutGrant(checkoutId: string, body: unknown): void {
  if (
    !isObject(body) || Object.keys(body).length !== 1 || typeof body.grant !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(body.grant) || !equalSecret(body.grant, checkoutGrant(checkoutId))
  ) {
    throw checkoutNotFound();
  }
}

export function baleStorefrontCheckoutUrl(checkoutId: string): string {
  const base = (process.env.FRONTEND_BASE_URL || process.env.FRONTEND_URL)?.trim();
  if (!base) throw baleUnavailable();
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw baleUnavailable();
  }
  const canUseHttp = process.env.NODE_ENV !== "production" && url.protocol === "http:";
  if (
    (url.protocol !== "https:" && !canUseHttp) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    throw baleUnavailable();
  }
  return `${url.origin}/bale/checkout/${encodeURIComponent(checkoutId)}`;
}

export function checkoutGrantUrl(checkoutId: string): string {
  return `${baleStorefrontCheckoutUrl(checkoutId)}#${checkoutGrant(checkoutId)}`;
}

export function baleReturnUrl(checkoutId: string): string {
  const username = process.env.BALE_BOT_USERNAME?.trim().replace(/^@/, "");
  if (!username || !/^[A-Za-z0-9_]{5,64}$/.test(username) || !isCheckoutId(checkoutId)) {
    return "https://ble.ir/";
  }
  return `https://ble.ir/${username}?start=${checkoutId}`;
}
