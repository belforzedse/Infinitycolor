"use client";

/**
 * Provider-neutral storefront analytics.
 *
 * Components emit a small ecommerce taxonomy through this module. The Umami
 * browser API is an implementation detail owned by AnalyticsTracker; callsites
 * never construct collector payloads or access window.umami directly.
 */

export const ANALYTICS_CONSENT_STORAGE_KEY = "analytics-consent";
export const ANALYTICS_CONSENT_EVENT = "analytics-consent-changed";
const ANALYTICS_ONCE_PREFIX = "analytics-once:";
const MAX_PENDING_CALLS = 100;

export type AnalyticsConsent = "granted" | "denied" | null;
export type AnalyticsTier = "basic" | "enhanced";
/** Client funnel steps. `purchase` is server-authoritative and is not emitted here. */
export type FunnelStep = "view_item" | "add_to_cart" | "begin_checkout";
export type AnalyticsContextKey = "route_group" | "product_id" | "category_id" | "experiment";
export type AnalyticsCategory =
  | "funnel"
  | "ecommerce"
  | "checkout"
  | "auth"
  | "engagement"
  | "search"
  | "content"
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
  "payment_completed",
  "payment_callback_success",
  "payment_callback_failed",
  "payment_callback_error",
  "order_success_page_view",
  "order_failure_page_view",
  "login",
  "account_created",
  "site_search",
  "click_add_to_cart",
  "share_product",
  "open_comments",
  "add_to_wishlist",
  "remove_from_wishlist",
  "apply_coupon",
  "content_impression",
  "content_interaction",
  "adaptive_quality_tier_change",
  "adaptive_quality_recovery_step",
  "adaptive_quality_route_summary",
  "adaptive_quality_web_vital_cls",
  "adaptive_quality_web_vital_fcp",
  "adaptive_quality_web_vital_inp",
  "adaptive_quality_web_vital_lcp",
  "adaptive_quality_web_vital_ttfb",
  "checkout_error",
] as const;

export type AnalyticsEventName = (typeof EVENT_NAME_VALUES)[number];
const EVENT_NAMES = new Set<string>(EVENT_NAME_VALUES);

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
  "auth",
  "engagement",
  "search",
  "content",
  "adaptive_quality",
]);

const SAFE_INTERNAL_ID = /^[a-zA-Z0-9_-]{1,50}$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_HOSTNAME = /^(?=.{1,253}$)[a-zA-Z0-9.-]+$/;
const SAFE_SCREEN = /^\d{2,5}x\d{2,5}$/;
const SAFE_LANGUAGE = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const LONG_DIGIT_RE = /\d{7,}/;

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

/**
 * Event data is deliberately allowlisted. Callers may pass a `properties`
 * object for ergonomics, but unknown keys and free text never reach Umami.
 */
const EVENT_PROPERTY_KEYS: Record<string, ReadonlySet<string>> = {
  site_search: new Set(["surface", "query_length_bucket", "result_count", "zero_results"]),
  content_impression: new Set(["placement"]),
  content_interaction: new Set(["placement"]),
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
  add_shipping_info: new Set(["value_irr", "currency"]),
  add_payment_info: new Set(["gateway"]),
  place_order_attempt: new Set(["gateway", "quantity", "value_irr", "currency"]),
  payment_redirect: new Set(["gateway", "value_irr", "currency"]),
  payment_completed: new Set(["gateway", "value_irr", "currency"]),
  payment_callback_success: new Set(["gateway"]),
  adaptive_quality_tier_change: new Set(["route_group", "experiment"]),
  adaptive_quality_recovery_step: new Set(["route_group", "experiment"]),
  adaptive_quality_route_summary: new Set(["route_group", "experiment"]),
  adaptive_quality_web_vital_cls: new Set(["route_group", "experiment"]),
  adaptive_quality_web_vital_fcp: new Set(["route_group", "experiment"]),
  adaptive_quality_web_vital_inp: new Set(["route_group", "experiment"]),
  adaptive_quality_web_vital_lcp: new Set(["route_group", "experiment"]),
  adaptive_quality_web_vital_ttfb: new Set(["route_group", "experiment"]),
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

export function getAnalyticsConsent(): AnalyticsConsent {
  if (typeof window === "undefined") return null;
  try {
    const value = localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY);
    return value === "granted" || value === "denied" ? value : null;
  } catch {
    return null;
  }
}

export function isDoNotTrackEnabled(): boolean {
  if (typeof navigator === "undefined") return false;
  const value =
    navigator.doNotTrack || (navigator as Navigator & { msDoNotTrack?: string }).msDoNotTrack;
  return value === "1" || value === "yes";
}

export function getAnalyticsTier(): AnalyticsTier {
  return getAnalyticsConsent() === "granted" && !isDoNotTrackEnabled() ? "enhanced" : "basic";
}

export function setAnalyticsConsent(value: Exclude<AnalyticsConsent, null>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, value);
  } catch {
    // The tracker remains cookieless and basic if storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(ANALYTICS_CONSENT_EVENT, { detail: { consent: value } }));
}

/** Consent is evaluated at send time by analyticsBeforeSend. */
export function syncAnalyticsConsentState(): void {
  // Intentionally empty. Umami is cookie-free; consent controls enrichment and
  // performance payloads instead of enabling a cookie mode.
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
  if (key === "value_irr") {
    const normalized = Number(value);
    return Number.isSafeInteger(normalized) && normalized >= 0 && normalized <= 10_000_000_000_000
      ? normalized
      : undefined;
  }
  if (key === "currency") return value === "IRR" ? "IRR" : undefined;
  if (key === "zero_results") return typeof value === "boolean" ? value : undefined;
  if (key === "query_length_bucket") {
    return ["1-3", "4-8", "9-16", "17+"].includes(String(value)) ? String(value) : undefined;
  }
  if (["placement", "gateway", "surface", "route_group", "experiment"].includes(key)) {
    const normalized = String(value ?? "").trim();
    return normalized && SAFE_CODE.test(normalized) && !containsPii(normalized)
      ? normalized
      : undefined;
  }
  return undefined;
}

function sanitizeEventProperties(
  eventName: string,
  properties: Record<string, unknown> | undefined,
): AnalyticsData {
  const allowed = EVENT_PROPERTY_KEYS[eventName] ?? new Set<string>();
  const clean: AnalyticsData = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (!allowed.has(key)) continue;
    const sanitized = sanitizeProperty(key, value);
    if (sanitized !== undefined) clean[key] = sanitized;
  }
  return clean;
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
    [
      "place_order_attempt",
      "payment_redirect",
      "payment_completed",
      "add_payment_info",
      "payment_callback_success",
    ].includes(action) &&
    SAFE_CODE.test(name) &&
    !containsPii(name)
  ) {
    properties.gateway = name;
  }

  return properties;
}

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
  if (type === "performance" && getAnalyticsTier() !== "enhanced") return null;
  const next = sanitizeBeforeSendPayload(type, payload);

  // Basic mode is intentionally cookieless and data-free. An identify payload
  // still retains its opaque `id`, which is required for signed-in attribution
  // even when consent is denied, unknown, or DNT is enabled.
  if ((type === "identify" || type === "event") && getAnalyticsTier() !== "enhanced") {
    delete next.data;
  }
  return next;
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
  if (getAnalyticsTier() !== "enhanced") return;
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
  "payment_completed",
  "apply_coupon",
]);

function tomanToIrr(value: unknown): number | undefined {
  const normalized = normalizeNumber(value);
  if (normalized === undefined || normalized < 0) return undefined;
  const irr = Math.round(normalized * 10);
  return Number.isSafeInteger(irr) && irr <= 10_000_000_000_000 ? irr : undefined;
}

function emitEvent(
  eventName: AnalyticsEventName,
  properties: Record<string, unknown>,
  onceKey?: string,
): void {
  if (shouldSkipOnce(onceKey)) return;
  const data = sanitizePayloadData(eventName, { ...context, ...properties });
  dispatch((api) => api.track(eventName, getAnalyticsTier() === "enhanced" ? data : undefined));
}

/** Provider-neutral typed event entrypoint. */
export function track(eventName: AnalyticsEventName, payload: AnalyticsEventPayload = {}): void {
  try {
    if (!EVENT_NAMES.has(eventName)) return;
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
    } else if (["click_add_to_cart", "update_quantity"].includes(eventName)) {
      properties.quantity = normalizeNumber(params.value);
    } else if (eventName === "view_item_list") {
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

export function trackSearch(query: string, surface: string, resultsCount?: number): void {
  trackSiteSearch(query, surface, resultsCount);
}

export function trackContentImpression(contentName: string, contentPiece?: string): void {
  void contentPiece;
  track("content_impression", {
    placement: SAFE_CODE.test(contentName) ? contentName : "content",
  });
}

export function trackContentInteraction(
  interaction: string,
  contentName: string,
  contentPiece?: string,
): void {
  void contentPiece;
  const placement = `${contentName}:${interaction}`;
  track("content_interaction", {
    placement: SAFE_CODE.test(placement)
      ? placement
      : SAFE_CODE.test(contentName)
        ? contentName
        : "content",
  });
}

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

export function identify(userId: string | number): void {
  const id = String(userId).trim();
  if (!id || !SAFE_INTERNAL_ID.test(id)) return;
  activeIdentity = id;
  dispatch((api) => api.identify(id));
}

export function resetIdentity(): void {
  activeIdentity = null;
  const guestId = getAnalyticsCorrelationId();
  dispatch((api) => api.identify(guestId));
}

/** Provider-neutral reset entrypoint. */
export const reset = resetIdentity;
