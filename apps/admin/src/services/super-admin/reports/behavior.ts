import { apiClient } from "@/services";
import { formatQueryParams } from "@/utils/api";
import {
  BEHAVIOR_VIEWS,
  type BehaviorFilters,
  type BehaviorMetadata,
  type BehaviorQuery,
  type BehaviorResponse,
  type BehaviorState,
  type BehaviorView,
} from "@/types/super-admin/reports/behavior";

export type BehaviorRequestOptions = {
  fresh?: boolean;
  signal?: AbortSignal;
};

/** Only aliases that intentionally remain during the Infinity route cutover. */
const COMPATIBILITY_ENDPOINTS: Record<BehaviorView, readonly string[]> = {
  overview: ["/reports/traffic/dashboard"],
  acquisition: [],
  conversion: ["/reports/funnel"],
  content: [],
  audience: [],
  performance: [],
  realtime: ["/reports/traffic/realtime"],
};

export const BEHAVIOR_FILTER_KEYS = [
  "path",
  "referrer",
  "title",
  "os",
  "browser",
  "device",
  "country",
  "region",
  "city",
  "tag",
  "hostname",
  "language",
  "event",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "utmContent",
  "utmTerm",
  "segment",
  "cohort",
  "excludeBounce",
  "match",
  "productId",
  "categoryId",
  "variantId",
] as const satisfies readonly (keyof BehaviorFilters)[];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const EVENT_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorStatus(error: unknown): number | null {
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  } | null;
  const parsed = Number(candidate?.status ?? candidate?.response?.status);
  return Number.isInteger(parsed) ? parsed : null;
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string")
    return error.message;
  return "درخواست گزارش رفتار کاربران ناموفق بود";
}

function responseEnvelope(response: unknown): Record<string, any> {
  if (!isRecord(response)) return {};
  if (isRecord(response.meta) && "data" in response) return response;
  if (
    isRecord(response.data) &&
    isRecord(response.data.meta) &&
    "data" in response.data
  ) {
    return response.data;
  }
  return response;
}

function stateFromEnvelope(envelope: Record<string, any>): BehaviorState {
  const state = envelope.meta?.status ?? envelope.state ?? envelope.status;
  if (["ok", "empty", "partial", "unavailable"].includes(state)) {
    return state as BehaviorState;
  }
  if (envelope.available === false || envelope.configured === false)
    return "unavailable";
  if (envelope.partial === true) return "partial";
  if (envelope.data === null) return "unavailable";
  return Object.keys(envelope).length ? "ok" : "empty";
}

function rangeFromValue(
  value: unknown,
): { start: string; end: string } | undefined {
  if (!isRecord(value)) return undefined;
  const start = value.start ?? value.startDate;
  const end = value.end ?? value.endDate;
  return typeof start === "string" && typeof end === "string"
    ? { start, end }
    : undefined;
}

function metadataFromEnvelope(
  envelope: Record<string, any>,
  query: BehaviorQuery,
  state: BehaviorState,
): BehaviorMetadata {
  const meta = isRecord(envelope.meta) ? envelope.meta : {};
  const source = typeof meta.source === "string" ? meta.source : "umami";
  const sectionErrors = isRecord(envelope.data?.errors)
    ? Object.keys(envelope.data.errors).map(
        (section) => `بخش ${section} در دسترس نیست`,
      )
    : [];
  const providerWarnings = Array.isArray(meta.warnings)
    ? meta.warnings.filter(
        (warning): warning is string =>
          typeof warning === "string" && warning.trim().length > 0,
      )
    : [];
  const warnings = Array.from(new Set([...providerWarnings, ...sectionErrors]));
  return {
    source,
    provider: source.toLowerCase() === "umami" ? "Umami" : source,
    timezone: typeof meta.timezone === "string" ? meta.timezone : "Asia/Tehran",
    unit: typeof meta.unit === "string" ? meta.unit : undefined,
    currency: typeof meta.currency === "string" ? meta.currency : undefined,
    definitionVersion:
      typeof meta.definitionVersion === "string"
        ? meta.definitionVersion
        : undefined,
    dataStart: typeof meta.dataStart === "string" ? meta.dataStart : null,
    refreshedAt: typeof meta.refreshedAt === "string" ? meta.refreshedAt : null,
    cache: ["fresh", "stale", "miss"].includes(meta.cache)
      ? meta.cache
      : undefined,
    status: state,
    requestedRange: rangeFromValue(meta.requestedRange) ?? {
      start: query.start,
      end: query.end,
    },
    comparisonRange:
      rangeFromValue(meta.comparisonRange) ??
      (query.comparison === "none" ? null : undefined),
    warnings: warnings.length ? warnings : undefined,
  };
}

function queryString(
  query: BehaviorQuery,
  options?: BehaviorRequestOptions,
): string {
  const params: Record<string, string | number> = {
    startDate: query.start,
    endDate: query.end,
    comparison: query.comparison ?? "none",
  };
  for (const key of BEHAVIOR_FILTER_KEYS) {
    const value = query.filters?.[key];
    if (typeof value === "string" && value.trim()) params[key] = value.trim();
  }
  if (options?.fresh) params.fresh = 1;
  return formatQueryParams(params);
}

export type BehaviorQueryValidation = {
  ok: boolean;
  errors: Partial<
    Record<"start" | "end" | "comparison" | keyof BehaviorFilters, string>
  >;
};

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function validateBehaviorQuery(
  query: BehaviorQuery,
): BehaviorQueryValidation {
  const errors: BehaviorQueryValidation["errors"] = {};
  if (!isDateOnly(query.start)) errors.start = "تاریخ شروع معتبر نیست";
  if (!isDateOnly(query.end)) errors.end = "تاریخ پایان معتبر نیست";
  if (
    isDateOnly(query.start) &&
    isDateOnly(query.end) &&
    query.start > query.end
  ) {
    errors.end = "تاریخ پایان باید بعد از شروع باشد";
  }
  if (
    query.comparison &&
    !["none", "previous_period"].includes(query.comparison)
  ) {
    errors.comparison = "نوع مقایسه معتبر نیست";
  }
  for (const [rawKey, rawValue] of Object.entries(query.filters ?? {})) {
    const key = rawKey as keyof BehaviorFilters;
    if (!BEHAVIOR_FILTER_KEYS.includes(key)) {
      errors[key] = "فیلتر پشتیبانی نمی‌شود";
      continue;
    }
    if (rawValue === undefined || rawValue === "") continue;
    if (typeof rawValue !== "string") {
      errors[key] = "مقدار فیلتر معتبر نیست";
      continue;
    }
    const value = rawValue.trim();
    if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
      errors[key] = "مقدار فیلتر معتبر نیست";
    } else if (
      (key === "segment" || key === "cohort") &&
      !UUID_PATTERN.test(value)
    ) {
      errors[key] = "شناسه باید UUID معتبر باشد";
    } else if (key === "event" && !EVENT_PATTERN.test(value)) {
      errors[key] = "نام رویداد معتبر نیست";
    } else if (
      ["productId", "categoryId", "variantId"].includes(key) &&
      !STABLE_ID_PATTERN.test(value)
    ) {
      errors[key] = "شناسه پایدار معتبر نیست";
    } else if (key === "match" && !["all", "any"].includes(value)) {
      errors[key] = "حالت تطبیق معتبر نیست";
    } else if (key === "excludeBounce" && !["true", "false"].includes(value)) {
      errors[key] = "مقدار حذف پرش معتبر نیست";
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

export function behaviorEndpoint(view: BehaviorView): string {
  if (!BEHAVIOR_VIEWS.includes(view))
    throw new Error("Unsupported behavior view");
  return `/reports/behavior/${view}`;
}

export async function getBehaviorView<T = Record<string, unknown>>(
  view: BehaviorView,
  query: BehaviorQuery,
  options?: BehaviorRequestOptions,
): Promise<BehaviorResponse<T>> {
  const endpoint = behaviorEndpoint(view);
  const validation = validateBehaviorQuery(query);
  if (!validation.ok) {
    return {
      state: "unavailable",
      data: null,
      metadata: {
        timezone: "Asia/Tehran",
        requestedRange: { start: query.start, end: query.end },
      },
      error: Object.values(validation.errors).filter(Boolean).join("؛ "),
      endpoint,
    };
  }

  const endpoints = [endpoint, ...COMPATIBILITY_ENDPOINTS[view]];
  let lastEndpoint = endpoint;
  let lastError: unknown = null;
  for (const candidate of endpoints) {
    lastEndpoint = candidate;
    try {
      const response = await apiClient.get(
        `${candidate}${queryString(query, options)}`,
        {
          signal: options?.signal,
          cache: "no-store",
        },
      );
      const envelope = responseEnvelope(response);
      const state = stateFromEnvelope(envelope);
      return {
        state,
        data: state === "unavailable" ? null : (envelope.data as T),
        metadata: metadataFromEnvelope(envelope, query, state),
        error:
          typeof envelope.error === "string"
            ? envelope.error
            : typeof envelope.message === "string"
              ? envelope.message
              : null,
        endpoint: candidate,
      };
    } catch (error) {
      if (options?.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      lastError = error;
      const status = errorStatus(error);
      if ((status !== 404 && status !== 405) || candidate === endpoints.at(-1))
        break;
    }
  }

  return {
    state: "unavailable",
    data: null,
    metadata: {
      timezone: "Asia/Tehran",
      requestedRange: { start: query.start, end: query.end },
    },
    error: errorMessage(lastError),
    endpoint: lastEndpoint,
  };
}

export { COMPATIBILITY_ENDPOINTS };
