/** Provider-neutral contracts for Infinity's behavior workspace. */

export const BEHAVIOR_VIEWS = [
  "overview",
  "acquisition",
  "conversion",
  "content",
  "audience",
  "performance",
  "realtime",
] as const;

export type BehaviorView = (typeof BEHAVIOR_VIEWS)[number];
export type BehaviorState = "ok" | "empty" | "partial" | "unavailable";
export type BehaviorCacheState = "fresh" | "stale" | "miss";

export type BehaviorFilters = {
  path?: string;
  referrer?: string;
  title?: string;
  os?: string;
  browser?: string;
  device?: string;
  country?: string;
  region?: string;
  city?: string;
  tag?: string;
  hostname?: string;
  language?: string;
  event?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  segment?: string;
  cohort?: string;
  excludeBounce?: "true" | "false";
  match?: "all" | "any";
  productId?: string;
  categoryId?: string;
  variantId?: string;
};

export type BehaviorQuery = {
  start: string;
  end: string;
  comparison?: "previous_period" | "none";
  filters?: BehaviorFilters;
};

export type BehaviorRange = { start: string; end: string };

export type BehaviorMetadata = {
  source?: string;
  provider?: string;
  timezone?: string;
  unit?: string;
  currency?: string;
  definitionVersion?: string;
  dataStart?: string | null;
  refreshedAt?: string | null;
  cache?: BehaviorCacheState;
  status?: BehaviorState;
  requestedRange?: BehaviorRange;
  comparisonRange?: BehaviorRange | null;
  warnings?: string[];
};

export type BehaviorMetricRow = {
  label?: string;
  value?: number;
  pageviews?: number;
  visitors?: number;
  visits?: number;
  bounces?: number;
  totaltime?: number;
  [key: string]: unknown;
};

export type BehaviorReportPayload = {
  kind?: string;
  range?: { startDate?: string; endDate?: string };
  summary?: Record<string, number>;
  sections?: Record<string, unknown>;
  errors?: Record<string, string>;
  comparison?: BehaviorReportPayload | null;
  comparisonStatus?: BehaviorState | null;
};

export type BehaviorRealtimeData = {
  activeVisitors?: number | null;
  topPages?: Array<{ path?: string; visitors?: number | null }>;
};

export type BehaviorResponse<T = BehaviorReportPayload | BehaviorRealtimeData> =
  {
    state: BehaviorState;
    data: T | null;
    metadata: BehaviorMetadata;
    error?: string | null;
    /** The endpoint that answered; useful while compatibility aliases exist. */
    endpoint?: string;
  };
