"use client";

import type { VideoTelemetryEvent } from "@repo/video-player";
/**
 * Provider-neutral storefront analytics.
 *
 * Components emit a small ecommerce taxonomy through this module. The Umami
 * browser API is an implementation detail owned by AnalyticsTracker; callsites
 * never construct collector payloads or access window.umami directly.
 *
 * The contract (event names, firing conditions, properties, purchase and dedupe
 * rules) is documented in docs/analytics.md.
 */

const ANALYTICS_ONCE_PREFIX = "analytics-once:";
const ANALYTICS_ORDER_ONCE_PREFIX = "analytics-order:";
const MAX_PENDING_CALLS = 100;

/** Client funnel steps emitted through `trackFunnelStep`. */
export type FunnelStep = "view_item" | "add_to_cart" | "begin_checkout";
export type AnalyticsContextKey = "route_group" | "product_id" | "category_id" | "experiment";
export type AnalyticsCategory =
  | "funnel"
  | "ecommerce"
  | "checkout"
  | "engagement"
  | "search"
  | "adaptive_quality";

export type AnalyticsPrimitive = string | number | boolean;
export type AnalyticsData = Record<string, AnalyticsPrimitive>;
type UmamiPayload = Record<string, unknown>;

type UmamiApi = {
  track: {
    (): void;
    (eventName: string, data?: AnalyticsData): void;
    (payload: UmamiPayload | ((defaults: UmamiPayload) => UmamiPayload)): void;
  };
  identify: {
    (id: string, data?: AnalyticsData): void;
    (data: AnalyticsData): void;
  };
};

type PendingCall = (api: UmamiApi) => void;

const context: Partial<Record<AnalyticsContextKey, AnalyticsPrimitive>> = {};
let activeIdentity: string | null = null;
let guestCorrelationId: string | null = null;
/** Fallback for once-per-order claims when browser storage is unavailable. */
const memoryOrderClaims = new Set<string>();

const EVENT_NAME_VALUES = [
  "view_item",
  "view_item_list",
  "select_item",
  "add_to_cart",
  "remove_from_cart",
  "update_quantity",
  "view_cart",
  "begin_checkout",
  "add_shipping_info",
  "add_payment_info",
  "place_order_attempt",
  "payment_redirect",
  "purchase",
  "payment_failed",
  "payment_cancelled",
  "payment_unresolved",
  "site_search",
  "click_add_to_cart",
  "share_product",
  "open_comments",
  "add_to_wishlist",
  "remove_from_wishlist",
  "apply_coupon",
  "adaptive_quality_tier_change",
  "adaptive_quality_recovery_step",
  "adaptive_quality_route_summary",
  "adaptive_quality_web_vital_cls",
  "adaptive_quality_web_vital_fcp",
  "adaptive_quality_web_vital_inp",
  "adaptive_quality_web_vital_lcp",
  "adaptive_quality_web_vital_ttfb",
  "checkout_error",
  "video_playback",
  "video_playback_error",
] as const;

export type AnalyticsEventName = (typeof EVENT_NAME_VALUES)[number];
const EVENT_NAMES = new Set<string>(EVENT_NAME_VALUES);

/**
 * Outcome events with their own guarded entrypoints (`trackPurchase`,
 * `trackPaymentOutcome`, `trackCheckoutFailure`), which own the once-per-order
 * claim and the required fields. The generic helpers refuse them.
 */
const GUARDED_EVENTS = new Set<string>([
  "purchase",
  "payment_failed",
  "payment_cancelled",
  "payment_unresolved",
  "checkout_error",
  // Only through `trackVideoPlayback`, which maps the player's fixed event shape.
  "video_playback",
  "video_playback_error",
]);

/** Stable, low-cardinality reasons. Detail belongs in Sentry, never in Umami. */
export const CHECKOUT_FAILURE_CATEGORIES = [
  "validation",
  "empty_cart",
  "stock_changed",
  "reservation_expired",
  "quote_changed",
  "gateway_unavailable",
  "finalize_failed",
  "handoff_failed",
  "network",
  "unknown",
] as const;
export type CheckoutFailureCategory = (typeof CHECKOUT_FAILURE_CATEGORIES)[number];

const CHECKOUT_CODE_CATEGORIES: Record<string, CheckoutFailureCategory> = {
  STOCK_CHANGED: "stock_changed",
  STOCK_RESERVATION_FAILED: "stock_changed",
  INVALID_ITEM: "stock_changed",
  CART_EMPTY: "empty_cart",
  CHECKOUT_QUOTE_CHANGED: "quote_changed",
  RESERVATION_EXPIRED: "reservation_expired",
  RESERVATION_LOOKUP_FAILED: "reservation_expired",
  INVALID_RESERVATION: "reservation_expired",
  ORDER_CANCELLED: "reservation_expired",
  PAYMENT_GATEWAY_DISABLED: "gateway_unavailable",
  PAYMENT_INITIATION_FAILED: "gateway_unavailable",
  SNAPPAY_UNAVAILABLE: "gateway_unavailable",
  SNAPPAY_INELIGIBLE: "gateway_unavailable",
  SNAPPAY_GATEWAY_RECORD_MISSING: "gateway_unavailable",
  WALLET_UNAVAILABLE: "gateway_unavailable",
  WALLET_SPLIT_DISABLED: "gateway_unavailable",
  WALLET_SPLIT_UNSUPPORTED_GATEWAY: "gateway_unavailable",
  ADDRESS_NOT_FOUND: "validation",
  ADDRESS_REQUIRED: "validation",
  ADDRESS_VALIDATION_FAILED: "validation",
  SHIPPING_REQUIRED: "validation",
  SHIPPING_VALIDATION_FAILED: "validation",
  INVALID_SHIPPING: "validation",
  DISCOUNT_USAGE_EXHAUSTED: "validation",
  SNAPPAY_INVALID_MOBILE: "validation",
  WALLET_INSUFFICIENT_AVAILABLE: "validation",
  NETWORK_ERROR: "network",
  UNKNOWN_ERROR: "unknown",
};

/** Maps a checkout/backend error code to its stable analytics category. */
export function checkoutFailureCategoryForCode(code?: string | null): CheckoutFailureCategory {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return "unknown";
  return CHECKOUT_CODE_CATEGORIES[normalized] ?? "finalize_failed";
}

export const PAYMENT_FAILURE_CATEGORIES = ["gateway_failed", "expired"] as const;
export type PaymentFailureCategory = (typeof PAYMENT_FAILURE_CATEGORIES)[number];

const FAILURE_CATEGORIES = new Set<string>([
  ...CHECKOUT_FAILURE_CATEGORIES,
  ...PAYMENT_FAILURE_CATEGORIES,
]);

export type AnalyticsEventPayload = {
  onceKey?: string;
  productId?: string | number;
  categoryId?: string | number;
  variantId?: string | number;
  placement?: string;
  quantity?: number;
  position?: number;
  /** Storefront values are expressed in Toman and converted to IRR at this boundary. */
  valueToman?: number;
  gateway?: string;
  resultCount?: number;
  routeGroup?: string;
  experiment?: string;
  search?: {
    surface: string;
    queryLengthBucket: string;
    resultCount?: number;
    zeroResults?: boolean;
  };
};

const ANALYTICS_CATEGORIES = new Set<AnalyticsCategory>([
  "funnel",
  "ecommerce",
  "checkout",
  "engagement",
  "search",
  "adaptive_quality",
]);

const SAFE_INTERNAL_ID = /^[a-zA-Z0-9_-]{1,50}$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_HOSTNAME = /^(?=.{1,253}$)[a-zA-Z0-9.-]+$/;
const SAFE_SCREEN = /^\d{2,5}x\d{2,5}$/;
const SAFE_LANGUAGE = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/;
/** Order ids are internal positive integers; exempt from the long-digit redaction. */
const SAFE_ORDER_ID = /^[1-9]\d{0,15}$/;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const LONG_DIGIT_RE = /\d{7,}/;
const MAX_MONEY_IRR = 10_000_000_000_000;

const UTM_KEYS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
]);

const SENSITIVE_ROOTS = new Set([
  "account",
  "addresses",
  "auth",
  "checkout",
  "likes",
  "my-account",
  "orders",
  "payment",
  "super-admin",
  "wallet",
]);

const SAFE_CODE = /^[a-zA-Z0-9_.:/|=-]{1,120}$/;
// The frontend tsconfig intentionally targets ES5, so avoid Unicode property
// escapes here while retaining non-ASCII (including Persian) stable slugs.
const SAFE_CONTEXT = /^[A-Za-z0-9_\u0080-\uFFFF._~:/|=-]{1,160}$/;

const CONTEXT_KEYS = new Set<AnalyticsContextKey>([
  "route_group",
  "product_id",
  "category_id",
  "experiment",
]);

const PAYMENT_OUTCOME_KEYS = new Set(["transaction_id", "gateway", "failure_category"]);

/**
 * Event data is deliberately allowlisted. Callers may pass a `properties`
 * object for ergonomics, but unknown keys and free text never reach Umami.
 * Umami's special `revenue` key is allowed on `purchase` only.
 */
const EVENT_PROPERTY_KEYS: Record<string, ReadonlySet<string>> = {
  site_search: new Set(["surface", "query_length_bucket", "result_count", "zero_results"]),
  view_item_list: new Set(["category_id", "placement", "result_count"]),
  select_item: new Set([
    "product_id",
    "category_id",
    "position",
    "placement",
    "value_irr",
    "currency",
  ]),
  view_item: new Set(["product_id", "category_id", "variant_id", "value_irr", "currency"]),
  add_to_cart: new Set([
    "product_id",
    "category_id",
    "variant_id",
    "quantity",
    "value_irr",
    "currency",
  ]),
  remove_from_cart: new Set([
    "product_id",
    "category_id",
    "variant_id",
    "quantity",
    "value_irr",
    "currency",
  ]),
  update_quantity: new Set(["product_id", "category_id", "variant_id", "quantity"]),
  view_cart: new Set(["quantity", "value_irr", "currency"]),
  begin_checkout: new Set(["quantity", "value_irr", "currency"]),
  click_add_to_cart: new Set(["product_id", "category_id", "variant_id", "quantity"]),
  share_product: new Set(["product_id"]),
  open_comments: new Set(["product_id"]),
  add_to_wishlist: new Set(["product_id"]),
  remove_from_wishlist: new Set(["product_id"]),
  apply_coupon: new Set(["value_irr", "currency"]),
  add_shipping_info: new Set(["shipping_method", "value_irr", "currency"]),
  add_payment_info: new Set(["gateway"]),
  place_order_attempt: new Set(["gateway", "quantity", "value_irr", "currency"]),
  payment_redirect: new Set(["gateway", "value_irr", "currency"]),
  purchase: new Set(["transaction_id", "revenue", "currency", "gateway"]),
  payment_failed: PAYMENT_OUTCOME_KEYS,
  payment_cancelled: PAYMENT_OUTCOME_KEYS,
  payment_unresolved: PAYMENT_OUTCOME_KEYS,
  checkout_error: new Set(["failure_category", "gateway"]),
  adaptive_quality_tier_change: new Set(["route_group", "experiment"]),
  adaptive_quality_recovery_step: new Set(["route_group", "experiment"]),
  adaptive_quality_route_summary: new Set(["route_group", "experiment"]),
  adaptive_quality_web_vital_cls: new Set(["route_group", "experiment"]),
  adaptive_quality_web_vital_fcp: new Set(["route_group", "experiment"]),
  adaptive_quality_web_vital_inp: new Set(["route_group", "experiment"]),
  adaptive_quality_web_vital_lcp: new Set(["route_group", "experiment"]),
  adaptive_quality_web_vital_ttfb: new Set(["route_group", "experiment"]),
  video_playback: new Set([
    "surface",
    "engine",
    "fell_back",
    "startup_ms",
    "startup_failed",
    "rebuffer_count",
    "rebuffer_ms",
    "watched_ms",
    "start_height",
    "max_height",
    "level_switches",
    "video_failure",
    "browser",
    "device",
    "media_host",
  ]),
  video_playback_error: new Set([
    "surface",
    "engine",
    "video_failure",
    "detail",
    "fatal",
    "browser",
    "device",
    "media_host",
  ]),
};

const PERFORMANCE_KEYS = new Set([
  "website",
  "url",
  "referrer",
  "id",
  "hostname",
  "screen",
  "language",
  "tag",
  "cls",
  "fcp",
  "inp",
  "lcp",
  "ttfb",
  "duration",
]);

export function isAnalyticsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (process.env.NEXT_PUBLIC_UMAMI_ENABLE_DEV === "true") return true;
  return process.env.NODE_ENV === "production";
}

function shouldSkipOnce(onceKey?: string): boolean {
  if (!onceKey || typeof window === "undefined") return false;
  try {
    const key = `${ANALYTICS_ONCE_PREFIX}${onceKey}`;
    if (sessionStorage.getItem(key) === "1") return true;
    sessionStorage.setItem(key, "1");
  } catch {
    return false;
  }
  return false;
}

/**
 * Claims `key` for this browser profile. `localStorage` survives reloads,
 * back/forward, remounts, and other tabs; when it is unavailable the claim
 * falls back to this page instance so the event still fires once here.
 */
function claimPersistentOnce(key: string): boolean {
  const storageKey = `${ANALYTICS_ORDER_ONCE_PREFIX}${key}`;
  if (memoryOrderClaims.has(storageKey)) return false;
  memoryOrderClaims.add(storageKey);
  try {
    if (window.localStorage.getItem(storageKey)) return false;
    window.localStorage.setItem(storageKey, String(Date.now()));
  } catch {
    // Storage blocked: the in-memory claim above still prevents repeats here.
  }
  return true;
}

function getApi(): UmamiApi | null {
  if (typeof window === "undefined") return null;
  return window.umami ?? null;
}

function dispatch(call: PendingCall): void {
  if (!isAnalyticsEnabled() || typeof window === "undefined") return;
  const api = getApi();
  if (api) {
    try {
      call(api);
    } catch {
      // Analytics never affects storefront behavior.
    }
    return;
  }
  const queue = (window.__analyticsPendingCalls ||= []);
  if (queue.length < MAX_PENDING_CALLS) queue.push(call);
}

export function flushPendingAnalytics(): void {
  if (typeof window === "undefined") return;
  const api = getApi();
  if (!api) return;
  const queue = window.__analyticsPendingCalls?.splice(0) ?? [];
  queue.forEach((call) => {
    try {
      call(api);
    } catch {
      // Best effort only.
    }
  });
}

function cleanSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || EMAIL_RE.test(trimmed) || LONG_DIGIT_RE.test(trimmed)) return "redacted";
  return trimmed.replace(/[^A-Za-z0-9_\u0080-\uFFFF._~-]/g, "-").slice(0, 160);
}

function containsPii(value: string): boolean {
  return EMAIL_RE.test(value) || LONG_DIGIT_RE.test(value);
}

function sanitizeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || containsPii(trimmed)) return undefined;
  return trimmed.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
}

/** Sanitizes free-text search/input values before any aggregate is emitted. */
export function sanitizeFreeText(value: string, maxLength = 120): string | null {
  const trimmed = value.trim();
  if (!trimmed || containsPii(trimmed)) return null;
  return trimmed.slice(0, maxLength);
}

export function sanitizeAnalyticsUrl(raw: string): string {
  try {
    const parsed = new URL(
      raw,
      typeof window !== "undefined" ? window.location.origin : "https://invalid.local",
    );
    const segments = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
    const root = segments[0]?.toLowerCase() ?? "";
    let pathname = parsed.pathname || "/";

    if (SENSITIVE_ROOTS.has(root)) {
      pathname = root === "orders" ? "/orders/:state" : `/${root}`;
    } else {
      pathname = `/${segments.map(cleanSegment).join("/")}`;
      if (pathname === "/") pathname = "/";
    }

    const safeQuery = new URLSearchParams();
    parsed.searchParams.forEach((value, key) => {
      const normalizedKey = key.toLowerCase();
      if (!UTM_KEYS.has(normalizedKey)) return;
      if (!SAFE_CODE.test(value) || containsPii(value)) return;
      safeQuery.set(normalizedKey, value.slice(0, 120));
    });
    const query = safeQuery.toString();
    return query ? `${pathname}?${query}` : pathname;
  } catch {
    return "/unknown";
  }
}

function sanitizeReferrer(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${sanitizeAnalyticsUrl(parsed.pathname)}`;
  } catch {
    return undefined;
  }
}

function hasNonUtmQuery(raw: string): boolean {
  try {
    const parsed = new URL(
      raw,
      typeof window !== "undefined" ? window.location.origin : "https://invalid.local",
    );
    return Array.from(parsed.searchParams.keys()).some((key) => !UTM_KEYS.has(key.toLowerCase()));
  } catch {
    return true;
  }
}

function sanitizePrimitive(value: unknown): AnalyticsPrimitive | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= 1_000_000_000_000 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160 || containsPii(trimmed)) return undefined;
  return trimmed;
}

function sanitizeMoneyIrr(value: unknown): number | undefined {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 && normalized <= MAX_MONEY_IRR
    ? normalized
    : undefined;
}

const VIDEO_DURATION_KEYS = new Set([
  "startup_ms",
  "rebuffer_count",
  "rebuffer_ms",
  "watched_ms",
  "start_height",
  "max_height",
  "level_switches",
]);
const VIDEO_BOOLEAN_KEYS = new Set(["fell_back", "startup_failed", "fatal"]);
const VIDEO_CODE_KEYS = new Set(["engine", "video_failure", "detail", "browser", "device"]);

function sanitizeProperty(key: string, value: unknown): AnalyticsPrimitive | undefined {
  if (["product_id", "category_id", "variant_id"].includes(key)) {
    const normalized = String(value ?? "").trim();
    return normalized && SAFE_CONTEXT.test(normalized) && !containsPii(normalized)
      ? normalized
      : undefined;
  }
  if (["quantity", "position", "result_count"].includes(key)) {
    const normalized = Number(value);
    return Number.isSafeInteger(normalized) && normalized >= 0 && normalized <= 1_000_000
      ? normalized
      : undefined;
  }
  if (key === "value_irr") return sanitizeMoneyIrr(value);
  if (key === "revenue") {
    const normalized = sanitizeMoneyIrr(value);
    return normalized && normalized > 0 ? normalized : undefined;
  }
  if (key === "transaction_id") {
    const normalized = String(value ?? "").trim();
    return SAFE_ORDER_ID.test(normalized) ? normalized : undefined;
  }
  if (key === "failure_category") {
    return FAILURE_CATEGORIES.has(String(value)) ? String(value) : undefined;
  }
  if (key === "currency") return value === "IRR" ? "IRR" : undefined;
  if (key === "zero_results") return typeof value === "boolean" ? value : undefined;
  if (VIDEO_DURATION_KEYS.has(key)) {
    const normalized = Math.round(Number(value));
    // Bounded: one view never legitimately exceeds an hour of any of these.
    return Number.isSafeInteger(normalized) && normalized >= 0 && normalized <= 3_600_000
      ? normalized
      : undefined;
  }
  if (VIDEO_BOOLEAN_KEYS.has(key)) return typeof value === "boolean" ? value : undefined;
  if (VIDEO_CODE_KEYS.has(key)) {
    const normalized = String(value ?? "").trim().replace(/\s+/g, "_");
    return normalized && SAFE_CODE.test(normalized) && !containsPii(normalized) ? normalized : undefined;
  }
  if (key === "media_host") {
    const normalized = String(value ?? "").trim();
    return SAFE_HOSTNAME.test(normalized) ? normalized : undefined;
  }
  if (key === "query_length_bucket") {
    return ["1-3", "4-8", "9-16", "17+"].includes(String(value)) ? String(value) : undefined;
  }
  if (
    ["placement", "gateway", "surface", "route_group", "experiment", "shipping_method"].includes(key)
  ) {
    const normalized = String(value ?? "").trim();
    return normalized && SAFE_CODE.test(normalized) && !containsPii(normalized)
      ? normalized
      : undefined;
  }
  return undefined;
}

function sanitizePayloadData(
  eventName: string | undefined,
  data: unknown,
): AnalyticsData | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const allowed = new Set([
    "route_group",
    "product_id",
    "category_id",
    "experiment",
    ...(eventName ? Array.from(EVENT_PROPERTY_KEYS[eventName] ?? []) : []),
  ]);
  const clean: AnalyticsData = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!allowed.has(key) && !CONTEXT_KEYS.has(key as AnalyticsContextKey)) continue;
    const sanitized = sanitizeProperty(key, value);
    if (sanitized !== undefined) clean[key] = sanitized;
  }
  return Object.keys(clean).length ? clean : undefined;
}

function sanitizeBeforeSendPayload(type: string, payload: UmamiPayload): UmamiPayload {
  const allowed =
    type === "performance"
      ? PERFORMANCE_KEYS
      : new Set([
          "website",
          "url",
          "referrer",
          "title",
          "id",
          "name",
          "data",
          "hostname",
          "screen",
          "language",
          "tag",
        ]);
  const next: UmamiPayload = {};
  Array.from(allowed).forEach((key) => {
    if (key in payload) next[key] = payload[key];
  });

  if (next.website !== undefined) {
    if (typeof next.website !== "string" || !CANONICAL_UUID.test(next.website)) return {};
  }

  if (typeof next.url === "string") next.url = sanitizeAnalyticsUrl(next.url);
  if (next.referrer !== undefined) {
    const referrer = sanitizeReferrer(next.referrer);
    if (referrer) next.referrer = referrer;
    else delete next.referrer;
  }
  if (next.title !== undefined) {
    const title = sanitizeTitle(next.title);
    if (title) next.title = title;
    else delete next.title;
  }
  if (next.id !== undefined && (typeof next.id !== "string" || !SAFE_INTERNAL_ID.test(next.id))) {
    delete next.id;
  }
  if (
    next.hostname !== undefined &&
    (typeof next.hostname !== "string" || !SAFE_HOSTNAME.test(next.hostname))
  ) {
    delete next.hostname;
  }
  if (
    next.screen !== undefined &&
    (typeof next.screen !== "string" || !SAFE_SCREEN.test(next.screen))
  ) {
    delete next.screen;
  }
  if (
    next.language !== undefined &&
    (typeof next.language !== "string" || !SAFE_LANGUAGE.test(next.language))
  ) {
    delete next.language;
  }
  if (next.tag !== undefined && (typeof next.tag !== "string" || !SAFE_CODE.test(next.tag))) {
    delete next.tag;
  }
  if (type === "event") {
    if (typeof next.name === "string" && !EVENT_NAMES.has(next.name)) return {};
    const data = sanitizePayloadData(
      typeof next.name === "string" ? next.name : undefined,
      next.data,
    );
    if (data) next.data = data;
    else delete next.data;
  }
  if (type === "identify") {
    const data = sanitizePayloadData(undefined, next.data);
    if (data) next.data = data;
    else delete next.data;
  }
  if (type === "performance") {
    for (const [key, value] of Object.entries(next)) {
      if (
        ["website", "url", "referrer", "id", "hostname", "screen", "language", "tag"].includes(key)
      )
        continue;
      if (typeof value !== "number" || !Number.isFinite(value)) delete next[key];
    }
  }
  return next;
}

function normalizeNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeEventName(category: string, action: string): AnalyticsEventName | null {
  const candidate =
    category === "adaptive_quality"
      ? `adaptive_quality_${action}`
      : action === "error"
        ? `${category}_error`
        : action;
  return EVENT_NAMES.has(candidate) ? (candidate as AnalyticsEventName) : null;
}

function extractStableProperties(category: string, action: string, name?: string): AnalyticsData {
  if (!name) return {};
  const properties: AnalyticsData = {};

  if (
    [
      "view_item",
      "select_item",
      "add_to_cart",
      "add_to_wishlist",
      "remove_from_wishlist",
      "share_product",
      "open_comments",
      "click_add_to_cart",
      "remove_from_cart",
      "update_quantity",
    ].includes(action)
  ) {
    const productId = name.match(/^(\d+)/)?.[1];
    const position = name.match(/(?:^|:)pos=(\d+)$/)?.[1];
    if (productId && SAFE_INTERNAL_ID.test(productId)) properties.product_id = productId;
    if (position) properties.position = Number(position);
    if (action === "click_add_to_cart") {
      const variationId = name.match(/^\d+:(\d+)/)?.[1];
      if (variationId && SAFE_INTERNAL_ID.test(variationId)) properties.variant_id = variationId;
    }
  } else if (
    category === "checkout" &&
    ["place_order_attempt", "payment_redirect", "add_payment_info"].includes(action) &&
    SAFE_CODE.test(name) &&
    !containsPii(name)
  ) {
    properties.gateway = name;
  }

  return properties;
}

/**
 * Umami `before-send` hook. Every visitor sends the same allowlisted, sanitized
 * payload: there is no consent tier. Unknown event names, non-UUID websites,
 * PII-shaped values, and non-allowlisted keys are still dropped here.
 */
export function analyticsBeforeSend(type: string, payload: UmamiPayload): UmamiPayload | null {
  if (!payload || typeof payload !== "object") return null;
  if (
    payload.website !== undefined &&
    (typeof payload.website !== "string" || !CANONICAL_UUID.test(payload.website))
  ) {
    return null;
  }
  if (type === "event" && typeof payload.name === "string" && !EVENT_NAMES.has(payload.name)) {
    return null;
  }
  return sanitizeBeforeSendPayload(type, payload);
}

export function trackPage(options: { url: string; title?: string; referrerUrl?: string }): void {
  const url = sanitizeAnalyticsUrl(options.url);
  const referrer = sanitizeReferrer(options.referrerUrl);
  const title = sanitizeTitle(options.title);
  dispatch((api) =>
    api.track((defaults) => ({
      ...defaults,
      url,
      ...(title &&
      !hasNonUtmQuery(options.url) &&
      !url.startsWith("/search") &&
      !url.startsWith("/account") &&
      !url.startsWith("/my-account") &&
      !url.startsWith("/orders") &&
      !url.startsWith("/checkout") &&
      !url.startsWith("/payment")
        ? { title }
        : {}),
      ...(referrer ? { referrer } : {}),
    })),
  );
}

export function setAnalyticsContext(key: AnalyticsContextKey, value: string | number): void {
  const normalized = String(value).trim();
  if (!CONTEXT_KEYS.has(key) || !normalized || normalized.length > 160 || containsPii(normalized))
    return;
  if (key === "route_group" && !SAFE_CODE.test(normalized)) return;
  if (key === "experiment" && !SAFE_CODE.test(normalized)) return;
  if (["product_id", "category_id"].includes(key) && !SAFE_CONTEXT.test(normalized)) return;
  context[key] = normalized;
}

export function deleteAnalyticsContext(key: AnalyticsContextKey): void {
  delete context[key];
}

export function setSessionProperties(
  properties: Partial<Record<AnalyticsContextKey, AnalyticsPrimitive>>,
): void {
  const clean: AnalyticsData = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!CONTEXT_KEYS.has(key as AnalyticsContextKey)) continue;
    const sanitized = sanitizePrimitive(value);
    if (sanitized === undefined) continue;
    if (["route_group", "experiment"].includes(key) && !SAFE_CODE.test(String(sanitized))) continue;
    if (
      ["product_id", "category_id"].includes(key) &&
      (typeof sanitized !== "string" || !SAFE_CONTEXT.test(sanitized))
    )
      continue;
    clean[key] = sanitized;
  }
  if (!Object.keys(clean).length) return;
  dispatch((api) => (activeIdentity ? api.identify(activeIdentity, clean) : api.identify(clean)));
}

export type AnalyticsTrackParams = {
  category: AnalyticsCategory;
  action: string;
  name?: string;
  /** @deprecated Prefer `valueToman`; retained for existing provider-neutral callsites. */
  value?: number;
  valueToman?: number;
  onceKey?: string;
  properties?: AnalyticsData;
};

const MONEY_EVENTS = new Set<AnalyticsEventName>([
  "view_item",
  "select_item",
  "add_to_cart",
  "remove_from_cart",
  "view_cart",
  "begin_checkout",
  "add_shipping_info",
  "place_order_attempt",
  "payment_redirect",
  "apply_coupon",
]);

function tomanToIrr(value: unknown): number | undefined {
  const normalized = normalizeNumber(value);
  if (normalized === undefined || normalized < 0) return undefined;
  const irr = Math.round(normalized * 10);
  return Number.isSafeInteger(irr) && irr <= MAX_MONEY_IRR ? irr : undefined;
}

function emitEvent(
  eventName: AnalyticsEventName,
  properties: Record<string, unknown>,
  onceKey?: string,
): void {
  if (shouldSkipOnce(onceKey)) return;
  const data = sanitizePayloadData(eventName, { ...context, ...properties });
  dispatch((api) => api.track(eventName, data));
}

/** Provider-neutral typed event entrypoint. */
export function track(eventName: AnalyticsEventName, payload: AnalyticsEventPayload = {}): void {
  try {
    if (!EVENT_NAMES.has(eventName) || GUARDED_EVENTS.has(eventName)) return;
    const properties: Record<string, unknown> = {
      product_id: payload.productId,
      category_id: payload.categoryId,
      variant_id: payload.variantId,
      placement: payload.placement,
      quantity: payload.quantity,
      position: payload.position,
      gateway: payload.gateway,
      result_count: payload.resultCount,
      route_group: payload.routeGroup,
      experiment: payload.experiment,
    };
    const valueIrr = tomanToIrr(payload.valueToman);
    if (valueIrr !== undefined) {
      properties.value_irr = valueIrr;
      properties.currency = "IRR";
    }
    if (payload.search) {
      properties.surface = payload.search.surface;
      properties.query_length_bucket = payload.search.queryLengthBucket;
      properties.result_count = payload.search.resultCount;
      properties.zero_results = payload.search.zeroResults;
    }
    emitEvent(eventName, properties, payload.onceKey);
  } catch {
    // Analytics never affects storefront or commerce behavior.
  }
}

/** Compatibility adapter for the existing storefront event callsites. */
export function trackAnalyticsEvent(params: AnalyticsTrackParams): void {
  try {
    const eventName = normalizeEventName(params.category, params.action);
    if (!eventName || !ANALYTICS_CATEGORIES.has(params.category)) return;
    if (GUARDED_EVENTS.has(eventName)) return;
    const properties: Record<string, unknown> = {
      ...extractStableProperties(params.category, params.action, params.name),
      ...params.properties,
    };
    const legacyValue = params.valueToman ?? params.value;
    if (MONEY_EVENTS.has(eventName)) {
      const valueIrr = tomanToIrr(legacyValue);
      if (valueIrr !== undefined) {
        properties.value_irr = valueIrr;
        properties.currency = "IRR";
      }
    } else if (
      ["click_add_to_cart", "update_quantity"].includes(eventName) &&
      properties.quantity === undefined &&
      params.value !== undefined
    ) {
      // Legacy callers passed the quantity as `value`; an explicit property wins.
      properties.quantity = normalizeNumber(params.value);
    } else if (
      eventName === "view_item_list" &&
      properties.result_count === undefined &&
      params.value !== undefined
    ) {
      properties.result_count = normalizeNumber(params.value);
    }
    emitEvent(eventName, properties, params.onceKey);
  } catch {
    // Analytics never affects storefront or commerce behavior.
  }
}

export function trackFunnelStep(
  step: FunnelStep,
  options?: {
    label?: string;
    value?: number;
    valueToman?: number;
    onceKey?: string;
    properties?: AnalyticsData;
  },
): void {
  trackAnalyticsEvent({
    category: "funnel",
    action: step,
    name: options?.label,
    value: options?.value,
    valueToman: options?.valueToman,
    onceKey: options?.onceKey,
    properties: options?.properties,
  });
}

/**
 * Video playback telemetry from `@repo/video-player`: one summary per played view, plus
 * error events (fatal, and recovered ones such as an HLS→MP4 fallback). Counts, timings and
 * low-cardinality codes only — no URLs beyond the media host, no user data.
 */
export function trackVideoPlayback(event: VideoTelemetryEvent): void {
  try {
    if (event.type === "summary") {
      emitEvent("video_playback", {
        surface: event.surface,
        engine: event.engine,
        fell_back: event.fellBack,
        ...(event.startupMs !== null ? { startup_ms: event.startupMs } : {}),
        startup_failed: event.startupFailed,
        rebuffer_count: event.rebufferCount,
        rebuffer_ms: event.rebufferMs,
        watched_ms: event.watchedMs,
        ...(event.startHeight ? { start_height: event.startHeight } : {}),
        ...(event.maxHeight ? { max_height: event.maxHeight } : {}),
        level_switches: event.levelSwitches,
        ...(event.failure ? { video_failure: event.failure } : {}),
        browser: event.browser,
        device: event.device,
        media_host: event.host,
      });
      return;
    }
    emitEvent("video_playback_error", {
      surface: event.surface,
      engine: event.engine,
      video_failure: event.failure,
      detail: event.detail,
      fatal: event.fatal,
      browser: event.browser,
      device: event.device,
      media_host: event.host,
    });
  } catch {
    // Analytics never affects playback.
  }
}

/** Records a checkout failure with a stable category; details belong in Sentry. */
export function trackCheckoutFailure(category: CheckoutFailureCategory, gateway?: string): void {
  try {
    emitEvent("checkout_error", {
      failure_category: FAILURE_CATEGORIES.has(category) ? category : "unknown",
      ...(gateway ? { gateway } : {}),
    });
  } catch {
    // Analytics never affects checkout.
  }
}

export type PurchaseInput = {
  orderId: number | string;
  /** Sum of the order's successful, non-return charges, in IRR, from the backend. */
  revenueIrr: number;
  gateway?: string;
};

/**
 * The revenue-bearing purchase. Call only once the backend has reported the
 * order as paid. Emits at most once per order per browser profile, no matter
 * how often the result page renders, reloads, polls, or is opened in tabs.
 * Returns whether this call emitted the event.
 */
export function trackPurchase(input: PurchaseInput): boolean {
  try {
    const transactionId = String(input.orderId ?? "").trim();
    const revenue = sanitizeMoneyIrr(input.revenueIrr);
    if (!SAFE_ORDER_ID.test(transactionId) || !revenue) return false;
    if (!isAnalyticsEnabled() || typeof window === "undefined") return false;
    if (!claimPersistentOnce(`purchase:${transactionId}`)) return false;
    emitEvent("purchase", {
      transaction_id: transactionId,
      revenue,
      currency: "IRR",
      gateway: input.gateway,
    });
    return true;
  } catch {
    return false;
  }
}

export type PaymentOutcomeEvent = "payment_failed" | "payment_cancelled" | "payment_unresolved";

/**
 * Non-paid payment outcomes seen on the result page. Deduplicated per order,
 * attempt, and outcome so a retry with a new attempt is counted separately.
 */
export function trackPaymentOutcome(
  eventName: PaymentOutcomeEvent,
  input: {
    orderId: number | string;
    attemptKey?: string | number | null;
    gateway?: string;
    failureCategory?: PaymentFailureCategory;
  },
): boolean {
  try {
    const transactionId = String(input.orderId ?? "").trim();
    if (!SAFE_ORDER_ID.test(transactionId)) return false;
    if (!isAnalyticsEnabled() || typeof window === "undefined") return false;
    const attempt = String(input.attemptKey ?? "latest").slice(0, 80);
    if (!claimPersistentOnce(`${eventName}:${transactionId}:${attempt}`)) return false;
    emitEvent(eventName, {
      transaction_id: transactionId,
      gateway: input.gateway,
      ...(eventName === "payment_failed" ? { failure_category: input.failureCategory } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

function queryLengthBucket(query: string): string {
  const length = Array.from(query.trim()).length;
  if (length <= 3) return "1-3";
  if (length <= 8) return "4-8";
  if (length <= 16) return "9-16";
  return "17+";
}

export function trackSiteSearch(query: string, surface = "plp", resultsCount?: number): void {
  const trimmed = sanitizeFreeText(query);
  if (!trimmed) return;
  const normalizedCount = normalizeNumber(resultsCount);
  track("site_search", {
    search: {
      surface: SAFE_CODE.test(surface) ? surface : "unknown",
      queryLengthBucket: queryLengthBucket(trimmed),
      ...(normalizedCount !== undefined
        ? { resultCount: normalizedCount, zeroResults: normalizedCount === 0 }
        : {}),
    },
  });
}

/**
 * Opaque value copied into order creation. It is no longer read by any
 * analytics path (server commerce events carry no distinct id) and is kept only
 * so the checkout payload stays unchanged.
 */
export function getAnalyticsCorrelationId(): string {
  if (activeIdentity) return activeIdentity;
  if (!guestCorrelationId) {
    const random =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    guestCorrelationId = `guest-${random}`;
  }
  return guestCorrelationId;
}

/** Links later events to a signed-in customer's opaque internal id. */
export function identify(userId: string | number): void {
  const id = String(userId).trim();
  if (!id || !SAFE_INTERNAL_ID.test(id) || activeIdentity === id) return;
  activeIdentity = id;
  dispatch((api) => api.identify(id));
}

/**
 * Forgets the signed-in id locally. Guests are never identified: Umami keys
 * sessions on IP + user agent, and a random per-page-load id only adds noise.
 */
export function resetIdentity(): void {
  activeIdentity = null;
}
