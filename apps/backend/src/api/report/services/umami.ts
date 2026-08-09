import { parsePositiveInt } from "../../../utils/parsePositiveInt";

export const UMAMI_REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || "Asia/Tehran";
export const UMAMI_DEFINITION_VERSION = "umami-infinity-v1";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type UmamiCollectorEvent = {
  type: "event" | "identify" | "performance";
  payload: {
    website: string;
    hostname?: string;
    screen?: string;
    language?: string;
    url: string;
    referrer?: string;
    title?: string;
    id?: string;
    name?: string;
    timestamp?: number;
    data?: Record<string, unknown>;
  };
};

export type UmamiRange = { startDate: string; endDate: string };

const DAY_MS = 86_400_000;

function toYyyyMmDd(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: UMAMI_REPORT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function parseYmdUtc(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("INVALID_DATE_RANGE");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new Error("INVALID_DATE_RANGE");
  }
  return date;
}

export function normalizeRange(start?: string, end?: string): UmamiRange {
  const now = new Date();
  const defaultEnd = new Date(now);
  const defaultStart = new Date(now);
  defaultStart.setDate(defaultStart.getDate() - 29);
  const startDate = start ? parseYmdUtc(start) : defaultStart;
  const endDate = end ? parseYmdUtc(end) : defaultEnd;
  if (endDate.getTime() < startDate.getTime()) throw new Error("INVALID_DATE_RANGE");
  return { startDate: toYyyyMmDd(startDate), endDate: toYyyyMmDd(endDate) };
}

export function previousRange(range: UmamiRange): UmamiRange {
  const startUtc = parseYmdUtc(range.startDate);
  const endUtc = parseYmdUtc(range.endDate);
  const lengthDays = Math.round((endUtc.getTime() - startUtc.getTime()) / DAY_MS) + 1;
  const prevEnd = new Date(startUtc.getTime() - DAY_MS);
  const prevStart = new Date(prevEnd.getTime() - (lengthDays - 1) * DAY_MS);
  return { startDate: toYyyyMmDd(prevStart), endDate: toYyyyMmDd(prevEnd) };
}

export type UmamiConfig = {
  baseUrl: string;
  websiteId: string;
  websiteAllowlist: Set<string>;
  username?: string;
  password?: string;
  apiToken?: string;
  hostname: string;
  timeoutMs: number;
  maxConcurrency: number;
};

function validBaseUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (
      (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

function asWebsiteList(value: unknown): Set<string> {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => UUID_PATTERN.test(item)),
  );
}

export function getUmamiConfig(env: NodeJS.ProcessEnv = process.env): UmamiConfig {
  const rawWebsiteId = String(env.UMAMI_WEBSITE_ID || "").trim();
  const websiteId = UUID_PATTERN.test(rawWebsiteId) ? rawWebsiteId : "";
  const configuredAllowlist = asWebsiteList(env.UMAMI_WEBSITE_ALLOWLIST);
  // In the common single-site setup the configured website id is the allowlist
  // entry. If an explicit list is supplied, it is authoritative and must not be
  // widened implicitly by UMAMI_WEBSITE_ID.
  if (websiteId && configuredAllowlist.size === 0) configuredAllowlist.add(websiteId);
  return {
    baseUrl: validBaseUrl(env.UMAMI_BASE_URL || env.UMAMI_URL),
    websiteId,
    websiteAllowlist: configuredAllowlist,
    username: String(env.UMAMI_USERNAME || env.UMAMI_READER_USERNAME || "").trim() || undefined,
    password: env.UMAMI_PASSWORD || env.UMAMI_READER_PASSWORD || undefined,
    apiToken: String(env.UMAMI_API_TOKEN || "").trim() || undefined,
    hostname: String(env.UMAMI_HOSTNAME || "infinitycolor.co").trim(),
    timeoutMs: parsePositiveInt(env.UMAMI_TIMEOUT_MS, 8_000),
    maxConcurrency: Math.max(1, Math.min(16, parsePositiveInt(env.UMAMI_MAX_CONCURRENCY, 6))),
  };
}

export function isUmamiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const config = getUmamiConfig(env);
  return Boolean(
    config.baseUrl &&
      config.websiteId &&
      config.websiteAllowlist.has(config.websiteId) &&
      (config.apiToken || (config.username && config.password)),
  );
}

/** Collector delivery does not require dashboard reader credentials. */
export function isUmamiCollectorConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const config = getUmamiConfig(env);
  return Boolean(
    config.baseUrl && config.websiteId && config.websiteAllowlist.has(config.websiteId),
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isArrayResponse(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function assertResponseShape(value: unknown, allowed: "record" | "array" | "either"): any {
  if (
    (allowed === "record" && !isRecord(value)) ||
    (allowed === "array" && !isArrayResponse(value)) ||
    (allowed === "either" && !isRecord(value) && !isArrayResponse(value))
  ) {
    throw new Error("UMAMI_INVALID_RESPONSE");
  }
  return value;
}

function decodeJwtExpiry(token: string): number | null {
  try {
    const segment = token.split(".")[1];
    if (!segment) return null;
    const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return Number.isFinite(Number(payload?.exp)) ? Number(payload.exp) * 1000 : null;
  } catch {
    return null;
  }
}

type Waiter = { resolve: () => void };

/** A small bounded semaphore shared by every report call in this process. */
class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push({ resolve }));
    this.active += 1;
    return () => this.release();
  }

  private release() {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.resolve();
  }
}

export class UmamiClient {
  private token: string | undefined;
  private tokenExpiresAt = 0;
  private loginPromise: Promise<string> | null = null;
  private readonly semaphore: Semaphore;

  constructor(private readonly config: UmamiConfig = getUmamiConfig()) {
    this.semaphore = new Semaphore(config.maxConcurrency);
    if (config.apiToken) {
      this.token = config.apiToken;
      this.tokenExpiresAt = Number.MAX_SAFE_INTEGER;
    }
  }

  isWebsiteAllowed(websiteId = this.config.websiteId): boolean {
    return Boolean(
      websiteId && this.config.websiteAllowlist.has(websiteId) && UUID_PATTERN.test(websiteId),
    );
  }

  private url(path: string, websiteId?: string): string {
    if (!this.config.baseUrl) throw new Error("UMAMI_CONFIG_MISSING");
    if (websiteId && !this.isWebsiteAllowed(websiteId))
      throw new Error("UMAMI_WEBSITE_NOT_ALLOWED");
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return new URL(normalizedPath, `${this.config.baseUrl}/`).toString();
  }

  private async login(): Promise<string> {
    if (this.token && this.tokenExpiresAt > Date.now() + 30_000) return this.token;
    if (!this.config.username || !this.config.password)
      throw new Error("UMAMI_AUTH_CONFIG_MISSING");
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const response = await this.rawRequest(
        "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ username: this.config.username, password: this.config.password }),
          headers: { "content-type": "application/json" },
        },
        false,
      );
      const body = assertResponseShape(response, "record");
      if (typeof body.token !== "string" || body.token.length < 16) {
        throw new Error("UMAMI_AUTH_INVALID_RESPONSE");
      }
      this.token = body.token;
      this.tokenExpiresAt = decodeJwtExpiry(body.token) || Date.now() + 15 * 60 * 1000;
      return body.token;
    })().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise as Promise<string>;
  }

  private async rawRequest(
    path: string,
    init: RequestInit,
    authenticated: boolean,
    websiteId?: string,
  ): Promise<unknown> {
    // Resolve authentication before taking the semaphore. Login itself uses
    // rawRequest, so acquiring first would deadlock when all report slots are
    // occupied by requests waiting for the shared token.
    const authToken = authenticated ? await this.login() : undefined;
    const release = await this.semaphore.acquire();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers = new Headers(init.headers || {});
      headers.set("accept", "application/json");
      if (authToken) headers.set("authorization", `Bearer ${authToken}`);
      const response = await fetch(this.url(path, websiteId), {
        ...init,
        headers,
        signal: controller.signal,
      });
      let body: unknown = null;
      if (typeof (response as any).text === "function") {
        const raw = await (response as any).text();
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          throw new Error("UMAMI_INVALID_JSON");
        }
      } else if (typeof (response as any).json === "function") {
        body = await (response as any).json();
      }
      if (!response.ok) {
        const error = new Error(
          response.status === 401 || response.status === 403
            ? "UMAMI_AUTH_FAILED"
            : `UMAMI_HTTP_${response.status}`,
        );
        (error as any).status = response.status;
        throw error;
      }
      if (isRecord(body) && body.result === "error") {
        throw new Error(String(body.message || "UMAMI_API_ERROR").slice(0, 160));
      }
      return body;
    } catch (error: any) {
      if (error?.name === "AbortError") throw new Error("UMAMI_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timeoutId);
      release();
    }
  }

  private readonly requestPromises = new Map<string, Promise<unknown>>();

  private async requestOnce(path: string, init: RequestInit, websiteId?: string): Promise<unknown> {
    try {
      return await this.rawRequest(path, init, true, websiteId);
    } catch (error: any) {
      if (error?.message !== "UMAMI_AUTH_FAILED" || this.config.apiToken) throw error;
      this.token = undefined;
      this.tokenExpiresAt = 0;
      return this.rawRequest(path, init, true, websiteId);
    }
  }

  /** Coalesce identical authenticated requests so a cold dashboard fan-out is bounded. */
  private request(path: string, init: RequestInit = {}, websiteId?: string): Promise<unknown> {
    const key = `${init.method || "GET"}:${websiteId || ""}:${path}:${String(init.body || "")}`;
    const existing = this.requestPromises.get(key);
    if (existing) return existing;
    const promise = this.requestOnce(path, init, websiteId).finally(() => {
      if (this.requestPromises.get(key) === promise) this.requestPromises.delete(key);
    });
    this.requestPromises.set(key, promise);
    return promise;
  }

  async statistics(
    range: UmamiRange,
    websiteId = this.config.websiteId,
    filters: Record<string, string> = {},
  ): Promise<Record<string, any>> {
    const query = new URLSearchParams({
      startAt: String(toTimestamp(range.startDate, false)),
      endAt: String(toTimestamp(range.endDate, true)),
    });
    Object.entries(standardUmamiFilters(filters)).forEach(([key, value]) => query.set(key, value));
    return assertResponseShape(
      await this.request(
        `/api/websites/${encodeURIComponent(websiteId)}/stats?${query}`,
        {},
        websiteId,
      ),
      "record",
    );
  }

  async metrics(
    type: string,
    range: UmamiRange,
    websiteId = this.config.websiteId,
    limit = 100,
    filters: Record<string, string> = {},
  ): Promise<unknown[]> {
    if (!/^[A-Za-z]{2,24}$/.test(type)) throw new Error("UMAMI_METRIC_NOT_ALLOWED");
    const query = new URLSearchParams({
      startAt: String(toTimestamp(range.startDate, false)),
      endAt: String(toTimestamp(range.endDate, true)),
      type,
      limit: String(Math.max(1, Math.min(500, limit))),
    });
    Object.entries(standardUmamiFilters(filters)).forEach(([key, value]) => query.set(key, value));
    return assertResponseShape(
      await this.request(
        `/api/websites/${encodeURIComponent(websiteId)}/metrics/expanded?${query}`,
        {},
        websiteId,
      ),
      "array",
    );
  }

  async realtime(websiteId = this.config.websiteId): Promise<Record<string, any>> {
    return assertResponseShape(
      await this.request(`/api/realtime/${encodeURIComponent(websiteId)}`, {}, websiteId),
      "record",
    );
  }

  async report(
    type: "goal" | "funnel" | "journey" | "retention" | "utm" | "attribution" | "performance",
    parameters: Record<string, unknown>,
    filters: Record<string, unknown> = {},
    websiteId = this.config.websiteId,
  ): Promise<unknown> {
    if (!this.isWebsiteAllowed(websiteId)) throw new Error("UMAMI_WEBSITE_NOT_ALLOWED");
    return this.request(
      `/api/reports/${type}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ websiteId, type, parameters, filters }),
      },
      websiteId,
    );
  }

  async eventDataPivot(
    eventName: string,
    range: UmamiRange,
    propertyFilters: Record<string, string>,
    filters: Record<string, string> = {},
    websiteId = this.config.websiteId,
  ): Promise<Record<string, any>> {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(eventName)) {
      throw new Error("UMAMI_EVENT_NAME_NOT_ALLOWED");
    }
    const query = new URLSearchParams({
      startAt: String(toTimestamp(range.startDate, false)),
      endAt: String(toTimestamp(range.endDate, true)),
      eventName,
      timezone: UMAMI_REPORT_TIMEZONE,
      unit: "day",
      maxResults: "10000",
    });
    Object.entries(standardUmamiFilters(filters)).forEach(([key, value]) => query.set(key, value));
    Object.entries(propertyFilters).forEach(([key, value]) => query.set(key, value));
    return assertResponseShape(
      await this.request(
        `/api/websites/${encodeURIComponent(websiteId)}/event-data-pivot?${query}`,
        {},
        websiteId,
      ),
      "record",
    );
  }

  async sendEvent(event: UmamiCollectorEvent): Promise<Record<string, any>> {
    if (!event || event.type !== "event" || !event.payload?.website || !event.payload?.name) {
      throw new Error("UMAMI_EVENT_INVALID");
    }
    if (!this.isWebsiteAllowed(event.payload.website)) throw new Error("UMAMI_WEBSITE_NOT_ALLOWED");
    const body = await this.rawRequest(
      "/api/send",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Umami intentionally rejects bots. Use a stable non-bot UA for the
          // authoritative commerce event while the distinct id joins it to the
          // browser session when a correlation id is available.
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/127.0.0.0 Safari/537.36",
        },
        body: JSON.stringify(event),
      },
      false,
    );
    const response = assertResponseShape(body, "record");
    if (
      typeof response.cache !== "string" ||
      typeof response.sessionId !== "string" ||
      typeof response.visitId !== "string"
    ) {
      throw new Error("UMAMI_COLLECTOR_REJECTED");
    }
    return response;
  }
}

let singleton: { key: string; client: UmamiClient } | null = null;

export function getUmamiClient(): UmamiClient {
  const config = getUmamiConfig();
  const key = JSON.stringify({
    baseUrl: config.baseUrl,
    websiteId: config.websiteId,
    username: config.username,
    password: config.password,
    apiToken: config.apiToken,
    hostname: config.hostname,
    websiteAllowlist: Array.from(config.websiteAllowlist).sort(),
    timeoutMs: config.timeoutMs,
    maxConcurrency: config.maxConcurrency,
  });
  if (!singleton || singleton.key !== key) singleton = { key, client: new UmamiClient(config) };
  return singleton.client;
}

function toTimestamp(value: string, end: boolean): number {
  const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}+03:30`);
  if (!Number.isFinite(date.getTime())) throw new Error("INVALID_DATE_RANGE");
  return date.getTime();
}

function normalizeNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rows(value: unknown): Array<Record<string, any>> {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, any> => isRecord(row))
    : [];
}

function rowLabel(row: Record<string, any>): string {
  return String(row.name ?? row.label ?? row.value ?? "Unknown").trim() || "Unknown";
}

function metricRows(value: unknown) {
  return rows(value).map((row) => ({
    label: rowLabel(row),
    pageviews: normalizeNumber(row.pageviews ?? row.views),
    visitors: normalizeNumber(row.visitors),
    visits: normalizeNumber(row.visits),
    bounces: normalizeNumber(row.bounces),
    totaltime: normalizeNumber(row.totaltime ?? row.totalTime),
    value: normalizeNumber(row.value ?? row.count ?? row.events),
  }));
}

export type UmamiBehaviorPayload = {
  kind: string;
  range: UmamiRange;
  summary?: Record<string, number>;
  sections: Record<string, unknown>;
  errors: Record<string, string>;
};

const metricTypes = {
  acquisition: [
    "channel",
    "referrer",
    "domain",
    "utmSource",
    "utmMedium",
    "utmCampaign",
    "utmContent",
    "utmTerm",
  ],
  content: ["path", "entry", "exit", "title", "event", "tag"],
  audience: ["device", "browser", "os", "language", "country", "region", "city"],
  conversion: ["event"],
  performance: [],
} as const;

const STANDARD_FILTER_KEYS = new Set([
  "path",
  "referrer",
  "title",
  "query",
  "os",
  "browser",
  "device",
  "country",
  "region",
  "city",
  "tag",
  "hostname",
  "distinctId",
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
]);

const PROPERTY_FILTER_KEYS = {
  productId: "product_id",
  categoryId: "category_id",
  variantId: "variant_id",
} as const;

const BEHAVIOR_FILTER_KEYS = new Set([
  ...STANDARD_FILTER_KEYS,
  ...Object.keys(PROPERTY_FILTER_KEYS),
]);

/** Keep every report filter inside Umami's fixed, documented filter surface. */
export function normalizeUmamiFilters(input: Record<string, unknown> = {}): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!BEHAVIOR_FILTER_KEYS.has(key) || value === undefined || value === null) continue;
    const normalized = String(value).trim();
    if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized))
      continue;
    if ((key === "segment" || key === "cohort") && !UUID_PATTERN.test(normalized)) continue;
    if (key === "match" && !["all", "any"].includes(normalized)) continue;
    if (key === "excludeBounce") {
      if (!["true", "false", "1", "0"].includes(normalized)) continue;
      // Umami 3.2 checks this filter for truthiness, so sending the string
      // "false" would still exclude bounced sessions. False means omission.
      if (normalized === "false" || normalized === "0") continue;
      filters[key] = "true";
      continue;
    }
    if (key in PROPERTY_FILTER_KEYS && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(normalized)) {
      continue;
    }
    if (key === "event" && !/^[a-z][a-z0-9_]{0,63}$/.test(normalized)) continue;
    filters[key] = normalized;
  }
  return filters;
}

function standardUmamiFilters(input: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(normalizeUmamiFilters(input)).filter(([key]) => STANDARD_FILTER_KEYS.has(key)),
  );
}

function eventPropertyFilters(input: Record<string, unknown>): Record<string, string> {
  const normalized = normalizeUmamiFilters(input);
  return Object.fromEntries(
    Object.entries(PROPERTY_FILTER_KEYS).flatMap(([inputKey, propertyName]) => {
      const value = normalized[inputKey];
      return value ? [[`pf_${propertyName}`, `1.eq.${value}`]] : [];
    }),
  );
}

function productFilterSummary(value: Record<string, any>) {
  const data = rows(value.data);
  const paths = new Map<string, number>();
  for (const row of data) {
    const path = String(row.urlPath || "").trim();
    if (path) paths.set(path, (paths.get(path) || 0) + 1);
  }
  return {
    matchedEvents: normalizeNumber(value.count ?? data.length),
    sampledEvents: data.length,
    paths: Array.from(paths, ([label, count]) => ({ label, value: count }))
      .sort((left, right) => right.value - left.value)
      .slice(0, 20),
  };
}

function reportParameters(range: UmamiRange) {
  return {
    startDate: `${range.startDate}T00:00:00.000+03:30`,
    endDate: `${range.endDate}T23:59:59.999+03:30`,
  };
}

async function captureSection(
  sections: Record<string, unknown>,
  errors: Record<string, string>,
  key: string,
  operation: () => Promise<unknown>,
) {
  try {
    const value = await operation();
    if (!isRecord(value) && !Array.isArray(value)) throw new Error("UMAMI_INVALID_RESPONSE");
    sections[key] = value;
  } catch (error: any) {
    errors[key] = String(error?.message || error).slice(0, 80);
  }
}

export async function getUmamiBehaviorReport(
  kind: keyof typeof metricTypes | "overview",
  range: UmamiRange,
  options: { advanced?: boolean; filters?: Record<string, unknown> } = {},
): Promise<UmamiBehaviorPayload> {
  if (!isUmamiConfigured()) {
    return { kind, range, sections: {}, errors: { source: "UMAMI_UNAVAILABLE" } };
  }
  const client = getUmamiClient();
  const normalizedFilters = normalizeUmamiFilters(options.filters);
  const filters = standardUmamiFilters(normalizedFilters);
  const propertyFilters = eventPropertyFilters(normalizedFilters);
  const sections: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  try {
    const summary = await client.statistics(range, undefined, filters);
    sections.summary = {
      pageviews: normalizeNumber(summary.pageviews ?? summary.views),
      visitors: normalizeNumber(summary.visitors),
      visits: normalizeNumber(summary.visits),
      bounces: normalizeNumber(summary.bounces),
      totaltime: normalizeNumber(summary.totaltime),
    };
  } catch (error: any) {
    errors.summary = String(error?.message || error).slice(0, 80);
  }
  const types = kind === "overview" ? (["path", "channel", "event"] as const) : metricTypes[kind];
  const settled = await Promise.allSettled(
    types.map(
      async (type) =>
        [type, metricRows(await client.metrics(type, range, undefined, 100, filters))] as const,
    ),
  );
  settled.forEach((result, index) => {
    const type = types[index];
    if (result.status === "fulfilled") sections[type] = result.value[1];
    else errors[type] = String(result.reason?.message || result.reason).slice(0, 80);
  });
  if (options.advanced && !sections.series) {
    try {
      const series = await client.metrics("path", range, undefined, 500, filters);
      sections.series = metricRows(series);
    } catch (error: any) {
      errors.series = String(error?.message || error).slice(0, 80);
    }
  }

  const dates = reportParameters(range);
  if (kind === "acquisition") {
    await Promise.all([
      captureSection(sections, errors, "utm", () => client.report("utm", dates, filters)),
      captureSection(sections, errors, "firstAttribution", () =>
        client.report(
          "attribution",
          { ...dates, model: "first-click", type: "event", step: "purchase" },
          filters,
        ),
      ),
      captureSection(sections, errors, "lastAttribution", () =>
        client.report(
          "attribution",
          { ...dates, model: "last-click", type: "event", step: "purchase" },
          filters,
        ),
      ),
    ]);
  } else if (kind === "conversion") {
    await Promise.all([
      captureSection(sections, errors, "purchaseGoal", () =>
        client.report("goal", { ...dates, type: "event", value: "purchase" }, filters),
      ),
      captureSection(sections, errors, "checkoutFunnel", () =>
        client.report(
          "funnel",
          {
            ...dates,
            window: 24 * 60,
            steps: ["view_item", "add_to_cart", "begin_checkout", "purchase"].map((value) => ({
              type: "event",
              value,
            })),
          },
          filters,
        ),
      ),
    ]);
  } else if (kind === "content") {
    await Promise.all([
      captureSection(sections, errors, "journeys", () =>
        client.report("journey", { ...dates, steps: 4 }, filters),
      ),
      ...(Object.keys(propertyFilters).length
        ? [
            captureSection(sections, errors, "productFilter", async () =>
              productFilterSummary(
                await client.eventDataPivot(
                  normalizedFilters.event || "view_item",
                  range,
                  propertyFilters,
                  filters,
                ),
              ),
            ),
          ]
        : []),
    ]);
  } else if (kind === "audience") {
    await captureSection(sections, errors, "retention", () =>
      client.report("retention", { ...dates, timezone: UMAMI_REPORT_TIMEZONE }, filters),
    );
  } else if (kind === "performance") {
    await captureSection(sections, errors, "performance", () =>
      client.report(
        "performance",
        { ...dates, unit: "day", timezone: UMAMI_REPORT_TIMEZONE, metric: "lcp" },
        filters,
      ),
    );
  }
  return {
    kind,
    range,
    summary: sections.summary as Record<string, number> | undefined,
    sections,
    errors,
  };
}

export async function getUmamiRealtimeReport(): Promise<{
  activeVisitors: number;
  topPages: Array<{ path: string; visitors: number }>;
  error?: string;
}> {
  if (!isUmamiConfigured()) {
    return { activeVisitors: 0, topPages: [], error: "UMAMI_UNAVAILABLE" };
  }
  try {
    const raw = await getUmamiClient().realtime();
    const visitorsByPath = new Map<string, Set<string>>();
    for (const event of rows(raw.events)) {
      const path = String(event.urlPath || "").trim();
      const sessionId = String(event.sessionId || "").trim();
      if (!path || path.length > 500 || /[\u0000-\u001f\u007f]/.test(path) || !sessionId) continue;
      const sessions = visitorsByPath.get(path) || new Set<string>();
      sessions.add(sessionId);
      visitorsByPath.set(path, sessions);
    }
    // Older/limited realtime responses may omit the activity array. Preserve a
    // bounded aggregate fallback without exposing the raw provider response.
    const fallbackUrls = isRecord(raw.urls) ? raw.urls : {};
    const topPages = (
      visitorsByPath.size
        ? Array.from(visitorsByPath, ([path, sessions]) => ({ path, visitors: sessions.size }))
        : Object.entries(fallbackUrls).flatMap(([path, value]) =>
            path && path.length <= 500 && !/[\u0000-\u001f\u007f]/.test(path)
              ? [{ path, visitors: normalizeNumber(value) }]
              : [],
          )
    )
      .sort((a, b) => b.visitors - a.visitors)
      .slice(0, 20);
    return {
      activeVisitors: normalizeNumber(raw.totals?.visitors ?? raw.visitors ?? raw.activeVisitors),
      topPages,
    };
  } catch (error: any) {
    return {
      activeVisitors: 0,
      topPages: [],
      error: String(error?.message || error).slice(0, 80),
    };
  }
}

export const __private = {
  validBaseUrl,
  decodeJwtExpiry,
  metricRows,
  toTimestamp,
  normalizeUmamiFilters,
};
