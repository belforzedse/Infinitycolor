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
  /** The Umami release the backend's report contract targets (declared, not detected). */
  providerContractVersion?: string;
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

/** One step of an ordered Umami funnel. Counts are distinct sessions («بازدیدکننده»). */
export type FunnelStepRow = {
  type?: string;
  value?: string;
  visitors?: number | null;
  previous?: number | null;
  dropped?: number | null;
  dropoff?: number | null;
  remaining?: number | null;
};

export type FunnelKey = "core" | "checkout" | "payment";
export type BreakdownDimension = "device" | "os" | "browser";

export type TrendPoint = {
  t: string;
  pageviews?: number | null;
  visitors?: number | null;
};

export type TrendSeries = {
  unit: "hour" | "day" | "month";
  points: TrendPoint[];
};

export type CommerceSeriesPoint = {
  t: string;
  paidOrders: number | null;
  revenueToman: number | null;
};

export type PurchaseTrackingStatus =
  | "live"
  | "degraded"
  | "not_live"
  | "unknown"
  | "unavailable";

/** Commerce ↔ Umami reconciliation of the `purchase` step for one period. */
export type PurchaseTracking = {
  umamiPurchaseSessions: number | null;
  commercePaidOrders: number | null;
  coverage: number | null;
  status: PurchaseTrackingStatus;
};

/** Which report filters an ordered funnel/goal honoured (session-level only). */
export type StepFilterScope = { applied: string[]; ignored: string[] };

export type ConversionDetailRequest =
  | { detail: "trend"; funnel: FunnelKey }
  | { detail: "breakdown"; funnel: FunnelKey; dimension: BreakdownDimension }
  | { detail: "journey"; step: string };

export type ConversionTrendBucket = {
  startDate: string;
  endDate: string;
  days: number;
  incomplete: boolean;
  beforeDataStart?: boolean;
  failed?: boolean;
  steps?: FunnelStepRow[];
  purchaseGoal?: { num?: number | null; total?: number | null } | null;
};

export type ConversionBreakdownSegment = {
  value: string;
  visitors?: number | null;
  steps?: FunnelStepRow[];
};
