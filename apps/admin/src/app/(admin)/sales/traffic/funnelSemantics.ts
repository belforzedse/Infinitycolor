import type {
  CommerceSeriesPoint,
  FunnelStepRow,
  PurchaseTracking,
  PurchaseTrackingStatus,
} from "@/types/super-admin/reports/behavior";
import { finite, pointChange } from "@/components/SuperAdmin/reports/shared/format";

/**
 * Funnel and conversion semantics for the traffic workspace, in one place so
 * every view of a funnel agrees.
 *
 * Unit: an Umami funnel counts distinct sessions («بازدیدکننده» in Umami's own
 * vocabulary: one device+browser, joined across a month). A step counts a
 * session only when it did every earlier step, in order, each within the
 * funnel's window of the step before. So:
 * - `shareOfEntrants` is step ÷ first step («از ورودی‌های قیف»);
 * - `fromPrevious` is step ÷ the step before («از مرحله قبل»);
 * - both are ratios (0–1); a changed rate is compared in percentage points.
 *
 * A ratio with a zero or missing base is `null` (not meaningful), never 0.
 */

export type FunnelStepView = {
  index: number;
  event: string;
  count: number | null;
  shareOfEntrants: number | null;
  fromPrevious: number | null;
  lost: number | null;
  dropoffRate: number | null;
  /** The purchase step while purchase tracking is incomplete for the range. */
  unreliable: boolean;
  previous: {
    count: number | null;
    shareOfEntrants: number | null;
    fromPrevious: number | null;
    dropoffRate: number | null;
  } | null;
  /** Change of `fromPrevious` against the previous period, in percentage points. */
  fromPreviousChangePp: number | null;
  shareOfEntrantsChangePp: number | null;
};

export type FunnelAnalysis = {
  steps: FunnelStepView[];
  entrants: number | null;
  /** Last step whose count can be trusted; the overall rate ends here. */
  lastReliableIndex: number;
  completed: number | null;
  overall: number | null;
  overallPrevious: number | null;
  overallChangePp: number | null;
  largestDrop: { index: number; lost: number; rate: number | null } | null;
  trackingIncomplete: boolean;
  /** Sessions entered the funnel, so rates exist. False means «no entrants». */
  hasEntrants: boolean;
  comparable: boolean;
};

function stepRows(value: unknown): FunnelStepRow[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is FunnelStepRow =>
          Boolean(row && typeof row === "object" && !Array.isArray(row)),
      )
    : [];
}

function ratio(numerator: number | null, denominator: number | null): number | null {
  return numerator === null || denominator === null || denominator <= 0
    ? null
    : numerator / denominator;
}

type RawStep = { event: string; count: number | null };

function readSteps(value: unknown): RawStep[] {
  return stepRows(value).map((row) => ({
    event: String(row.value ?? "").trim(),
    count: finite(row.visitors),
  }));
}

/** Purchase-based numbers are withheld only when tracking is known to be missing. */
export function purchaseTrackingReliable(tracking?: PurchaseTracking | null): boolean {
  const status: PurchaseTrackingStatus | undefined = tracking?.status;
  return status !== "not_live" && status !== "degraded";
}

type Derived = {
  shareOfEntrants: number | null;
  fromPrevious: number | null;
  lost: number | null;
  dropoffRate: number | null;
};

function derive(steps: RawStep[]): Derived[] {
  const entrants = steps[0]?.count ?? null;
  return steps.map((step, index) => {
    const before = index ? steps[index - 1].count : null;
    const lost =
      index && before !== null && step.count !== null ? Math.max(0, before - step.count) : null;
    return {
      shareOfEntrants: ratio(step.count, entrants),
      fromPrevious: index ? ratio(step.count, before) : null,
      lost,
      dropoffRate: index ? ratio(lost, before) : null,
    };
  });
}

/**
 * Analyse one funnel (and optionally the same funnel in the previous period).
 * Returns null when the funnel itself is unavailable — as opposed to present
 * with zero entrants, which is a real, reportable state.
 */
export function analyzeFunnel(
  current: unknown,
  previous?: unknown,
  options: { purchaseReliable?: boolean; previousPurchaseReliable?: boolean } = {},
): FunnelAnalysis | null {
  const steps = readSteps(current);
  if (!steps.length || steps[0].count === null) return null;
  const purchaseReliable = options.purchaseReliable ?? true;
  const derived = derive(steps);

  const previousSteps = readSteps(previous);
  const comparable =
    previousSteps.length === steps.length &&
    previousSteps.every((step, index) => step.event === steps[index].event) &&
    (previousSteps[0]?.count ?? 0) > 0;
  const previousDerived = comparable ? derive(previousSteps) : [];
  const previousReliable = options.previousPurchaseReliable ?? true;

  const views: FunnelStepView[] = steps.map((step, index) => {
    const unreliable = step.event === "purchase" && !purchaseReliable;
    const previousUnreliable = step.event === "purchase" && !previousReliable;
    const before = comparable && !previousUnreliable ? previousDerived[index] : null;
    const prior = before
      ? {
          count: previousSteps[index].count,
          shareOfEntrants: before.shareOfEntrants,
          fromPrevious: before.fromPrevious,
          dropoffRate: before.dropoffRate,
        }
      : null;
    return {
      index,
      event: step.event,
      count: step.count,
      ...derived[index],
      unreliable,
      previous: prior,
      fromPreviousChangePp:
        prior && !unreliable ? pointChange(derived[index].fromPrevious, prior.fromPrevious) : null,
      shareOfEntrantsChangePp:
        prior && !unreliable
          ? pointChange(derived[index].shareOfEntrants, prior.shareOfEntrants)
          : null,
    };
  });

  let lastReliableIndex = views.length - 1;
  while (lastReliableIndex > 0 && views[lastReliableIndex].unreliable) lastReliableIndex -= 1;
  const entrants = steps[0].count;
  const completed = views[lastReliableIndex].count;
  const overall = ratio(completed, entrants);
  // Compare like with like: the previous period ends at the same step, and a
  // purchase end only counts when that period's tracking was complete too.
  const previousEndUsable =
    comparable && (views[lastReliableIndex].event !== "purchase" || previousReliable);
  const overallPrevious = previousEndUsable
    ? ratio(previousSteps[lastReliableIndex].count, previousSteps[0].count)
    : null;

  let largestDrop: FunnelAnalysis["largestDrop"] = null;
  for (const view of views.slice(1, lastReliableIndex + 1)) {
    if (view.lost === null || view.lost <= 0) continue;
    if (!largestDrop || view.lost > largestDrop.lost) {
      largestDrop = { index: view.index, lost: view.lost, rate: view.dropoffRate };
    }
  }

  return {
    steps: views,
    entrants,
    lastReliableIndex,
    completed,
    overall,
    overallPrevious,
    overallChangePp: pointChange(overall, overallPrevious),
    largestDrop,
    trackingIncomplete: views.some((view) => view.unreliable),
    hasEntrants: (entrants ?? 0) > 0,
    comparable,
  };
}

/* ------------------------------------------------------------------------ */
/* Conversion KPI definitions                                                */
/* ------------------------------------------------------------------------ */

export type ConversionDefinitionId = "visitor" | "product" | "cart" | "checkout";

export const CONVERSION_DEFINITIONS: ReadonlyArray<{
  id: ConversionDefinitionId;
  label: string;
  numerator: string;
  denominator: string;
  source: string;
}> = [
  {
    id: "visitor",
    label: "بازدیدکننده ← خرید",
    numerator: "بازدیدکننده‌ای که خرید کرد",
    denominator: "همه بازدیدکنندگان",
    source: "هدف خرید در Umami، بدون ترتیب یا بازه زمانی",
  },
  {
    id: "product",
    label: "مشاهده محصول ← خرید",
    numerator: "به خرید رسیدند",
    denominator: "محصولی دیدند",
    source: "قیف «مسیر کامل خرید»",
  },
  {
    id: "cart",
    label: "سبد خرید ← خرید",
    numerator: "به خرید رسیدند",
    denominator: "پس از دیدن محصول به سبد افزودند",
    source: "قیف «مسیر کامل خرید»، از مرحله افزودن به سبد",
  },
  {
    id: "checkout",
    label: "شروع ثبت سفارش ← خرید",
    numerator: "به خرید رسیدند",
    denominator: "ثبت سفارش را شروع کردند",
    source: "قیف «ثبت سفارش»",
  },
];

export type ConversionRate = {
  numerator: number | null;
  denominator: number | null;
  rate: number | null;
  previousRate: number | null;
  changePp: number | null;
  /** `incomplete`: purchase tracking is missing for part of the range. */
  status: "ok" | "incomplete" | "unavailable" | "no_denominator";
};

type ConversionInputs = {
  goal?: unknown;
  previousGoal?: unknown;
  core?: unknown;
  previousCore?: unknown;
  checkout?: unknown;
  previousCheckout?: unknown;
  tracking?: PurchaseTracking | null;
  previousTracking?: PurchaseTracking | null;
};

function goalPair(value: unknown): [number | null, number | null] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return [finite(record.num), finite(record.total)];
}

function funnelPair(value: unknown, fromIndex: number): [number | null, number | null] | null {
  const steps = readSteps(value);
  if (!steps.length || steps[steps.length - 1].event !== "purchase") return null;
  return [steps[steps.length - 1].count, steps[fromIndex]?.count ?? null];
}

function pairFor(
  id: ConversionDefinitionId,
  goal: unknown,
  core: unknown,
  checkout: unknown,
): [number | null, number | null] | null {
  if (id === "visitor") return goalPair(goal);
  if (id === "product") return funnelPair(core, 0);
  if (id === "cart") return funnelPair(core, 1);
  return funnelPair(checkout, 0);
}

/** Every definition ends at `purchase`, so every one honours the tracking guard. */
export function conversionRate(
  id: ConversionDefinitionId,
  inputs: ConversionInputs,
): ConversionRate {
  const pair = pairFor(id, inputs.goal, inputs.core, inputs.checkout);
  const previousPair = pairFor(id, inputs.previousGoal, inputs.previousCore, inputs.previousCheckout);
  const reliable = purchaseTrackingReliable(inputs.tracking);
  const previousReliable = purchaseTrackingReliable(inputs.previousTracking);
  if (!pair || pair[0] === null || pair[1] === null) {
    return {
      numerator: null,
      denominator: null,
      rate: null,
      previousRate: null,
      changePp: null,
      status: "unavailable",
    };
  }
  const [numerator, denominator] = pair;
  const rate = ratio(numerator, denominator);
  const previousRate =
    previousPair && previousReliable ? ratio(previousPair[0], previousPair[1]) : null;
  if (!reliable) {
    return {
      numerator,
      denominator,
      rate: null,
      previousRate,
      changePp: null,
      status: "incomplete",
    };
  }
  return {
    numerator,
    denominator,
    rate,
    previousRate,
    changePp: pointChange(rate, previousRate),
    status: rate === null ? "no_denominator" : "ok",
  };
}

/** A range whose last day is today (Tehran) has sessions still inside their window. */
export function isOpenRange(end: string, today: string): boolean {
  return end >= today;
}

/**
 * The backend's reconciliation rule (report controller `purchaseTracking`),
 * applied to a sub-period: Umami purchase sessions against paid orders.
 */
export function trackingStatusFor(
  purchaseSessions: number | null,
  paidOrders: number | null,
): PurchaseTrackingStatus {
  if (purchaseSessions === null || paidOrders === null) return "unavailable";
  if (paidOrders < 5) return "unknown";
  const coverage = purchaseSessions / paidOrders;
  if (coverage < 0.05) return "not_live";
  if (coverage < 0.5) return "degraded";
  return "live";
}

/** Paid orders of the commerce series inside [start, end] (Tehran dates); null if uncovered. */
export function paidOrdersBetween(
  points: ReadonlyArray<CommerceSeriesPoint> | null | undefined,
  start: string,
  end: string,
): number | null {
  if (!points?.length || points[0].t.length < 10) return null;
  let total = 0;
  let covered = false;
  for (const point of points) {
    const day = point.t.slice(0, 10);
    if (day < start || day > end) continue;
    if (point.paidOrders === null) return null;
    covered = true;
    total += point.paidOrders;
  }
  return covered ? total : null;
}
