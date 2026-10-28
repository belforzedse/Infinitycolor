import {
  analyzeFunnel,
  conversionRate,
  isOpenRange,
  paidOrdersBetween,
  purchaseTrackingReliable,
  trackingStatusFor,
} from "../funnelSemantics";
import {
  pointChange,
  ratioText,
  relativeChange,
  signedPointsText,
} from "@/components/SuperAdmin/reports/shared/format";
import { buildTrendRows } from "../_components/TrendChart";
import { trendBucketViews } from "../_components/FunnelTrend";

const CORE = [
  "view_item",
  "add_to_cart",
  "begin_checkout",
  "add_shipping_info",
  "place_order_attempt",
  "purchase",
];
const funnel = (counts: Array<number | null | string>, events = CORE) =>
  counts.map((visitors, index) => ({ type: "event", value: events[index], visitors }));

describe("funnel semantics", () => {
  it("separates previous-step conversion from share of entrants, with exact losses", () => {
    const analysis = analyzeFunnel(funnel([1000, 130, 46, 37, 31, 25]))!;
    const [view, cart, checkout, , , purchase] = analysis.steps;
    expect(view.fromPrevious).toBeNull();
    expect(view.shareOfEntrants).toBe(1);
    expect(cart.fromPrevious).toBeCloseTo(0.13);
    expect(cart.lost).toBe(870);
    expect(cart.dropoffRate).toBeCloseTo(0.87);
    expect(checkout.fromPrevious).toBeCloseTo(46 / 130);
    expect(checkout.shareOfEntrants).toBeCloseTo(0.046);
    expect(purchase.fromPrevious).toBeCloseTo(25 / 31);
    expect(analysis.overall).toBeCloseTo(0.025);
    expect(analysis.completed).toBe(25);
    expect(analysis.lastReliableIndex).toBe(5);
  });

  it("names the largest drop-off by people lost, not by rate", () => {
    // 900 → 450 loses 450 people at 50%; 20 → 2 loses 18 people at 90%.
    const analysis = analyzeFunnel(funnel([900, 450, 20, 2], CORE.slice(0, 4)))!;
    expect(analysis.largestDrop).toEqual({ index: 1, lost: 450, rate: 0.5 });
  });

  it("keeps zero entrants reportable and an unavailable funnel distinct from it", () => {
    const zero = analyzeFunnel(funnel([0, 0, 0], CORE.slice(0, 3)))!;
    expect(zero.hasEntrants).toBe(false);
    expect(zero.overall).toBeNull();
    expect(zero.steps[1].fromPrevious).toBeNull();
    expect(zero.largestDrop).toBeNull();
    expect(analyzeFunnel(undefined)).toBeNull();
    expect(analyzeFunnel([])).toBeNull();
    expect(analyzeFunnel(funnel([null, 4], CORE.slice(0, 2)))).toBeNull();
  });

  it("treats an unreadable count as missing, never as zero", () => {
    const analysis = analyzeFunnel(funnel([100, "n/a", 10], CORE.slice(0, 3)))!;
    expect(analysis.steps[1].count).toBeNull();
    expect(analysis.steps[1].lost).toBeNull();
    expect(analysis.steps[2].fromPrevious).toBeNull();
  });

  it("compares with the previous period in percentage points, only when steps match", () => {
    const analysis = analyzeFunnel(
      funnel([1000, 130, 46, 37, 31, 25]),
      funnel([800, 80, 30, 25, 20, 16]),
    )!;
    expect(analysis.comparable).toBe(true);
    // 13% now against 10% before.
    expect(analysis.steps[1].fromPreviousChangePp).toBeCloseTo(3);
    expect(analysis.overallPrevious).toBeCloseTo(0.02);
    expect(analysis.overallChangePp).toBeCloseTo(0.5);
    const mismatched = analyzeFunnel(funnel([10, 5], CORE.slice(0, 2)), funnel([10, 5], ["view_item", "purchase"]))!;
    expect(mismatched.comparable).toBe(false);
    expect(mismatched.steps[1].fromPreviousChangePp).toBeNull();
  });

  it("withholds the purchase step when tracking is incomplete instead of reporting a collapse", () => {
    const analysis = analyzeFunnel(
      funnel([1000, 130, 46, 37, 31, 1]),
      funnel([800, 80, 30, 25, 20, 16]),
      { purchaseReliable: false, previousPurchaseReliable: true },
    )!;
    expect(analysis.trackingIncomplete).toBe(true);
    expect(analysis.steps[5].unreliable).toBe(true);
    expect(analysis.lastReliableIndex).toBe(4);
    expect(analysis.completed).toBe(31);
    expect(analysis.overall).toBeCloseTo(0.031);
    // The 30-person "drop" into purchase is a tracking gap, not the largest loss.
    expect(analysis.largestDrop?.index).toBe(1);
    expect(analysis.steps[5].fromPreviousChangePp).toBeNull();
    // The previous period is compared at the same (last reliable) step.
    expect(analysis.overallPrevious).toBeCloseTo(0.025);
  });

  it("does not compare an overall rate against a period whose purchases were not tracked", () => {
    const analysis = analyzeFunnel(funnel([100, 10, 5, 4, 4, 3]), funnel([100, 10, 5, 4, 4, 0]), {
      purchaseReliable: true,
      previousPurchaseReliable: false,
    })!;
    expect(analysis.overall).toBeCloseTo(0.03);
    expect(analysis.overallPrevious).toBeNull();
    expect(analysis.overallChangePp).toBeNull();
  });
});

describe("conversion definitions", () => {
  const core = funnel([1000, 130, 46, 37, 31, 25]);
  const checkout = funnel([46, 37, 31, 25], CORE.slice(2));

  it("names its numerator and denominator for every definition", () => {
    expect(conversionRate("visitor", { goal: { num: 25, total: 5000 } })).toMatchObject({
      numerator: 25,
      denominator: 5000,
      rate: 0.005,
      status: "ok",
    });
    expect(conversionRate("product", { core })).toMatchObject({ numerator: 25, denominator: 1000 });
    expect(conversionRate("cart", { core })).toMatchObject({ numerator: 25, denominator: 130 });
    expect(conversionRate("checkout", { checkout })).toMatchObject({ numerator: 25, denominator: 46 });
  });

  it("reports the change against the previous period in percentage points", () => {
    const rate = conversionRate("visitor", {
      goal: { num: 30, total: 1000 },
      previousGoal: { num: 20, total: 1000 },
    });
    expect(rate.changePp).toBeCloseTo(1);
  });

  it("distinguishes unavailable, no denominator, and incomplete tracking", () => {
    expect(conversionRate("visitor", {}).status).toBe("unavailable");
    expect(conversionRate("visitor", { goal: { num: 0, total: 0 } }).status).toBe("no_denominator");
    const incomplete = conversionRate("visitor", {
      goal: { num: 1, total: 180_000 },
      tracking: { status: "not_live", umamiPurchaseSessions: 1, commercePaidOrders: 900, coverage: 0.001 },
    });
    expect(incomplete.status).toBe("incomplete");
    expect(incomplete.rate).toBeNull();
    // A funnel that does not end in purchase cannot answer a purchase question.
    expect(conversionRate("product", { core: funnel([10, 5], CORE.slice(0, 2)) }).status).toBe("unavailable");
  });

  it("uses the backend's reconciliation thresholds for sub-periods", () => {
    expect(trackingStatusFor(null, 10)).toBe("unavailable");
    expect(trackingStatusFor(0, 4)).toBe("unknown");
    expect(trackingStatusFor(0, 40)).toBe("not_live");
    expect(trackingStatusFor(12, 40)).toBe("degraded");
    expect(trackingStatusFor(34, 40)).toBe("live");
    expect(purchaseTrackingReliable(null)).toBe(true);
    expect(purchaseTrackingReliable({ status: "unknown" } as never)).toBe(true);
    expect(purchaseTrackingReliable({ status: "degraded" } as never)).toBe(false);
  });

  it("sums paid orders inside a bucket and refuses days the ledger did not cover", () => {
    const points = [
      { t: "2026-09-13", paidOrders: null, revenueToman: null },
      { t: "2026-09-14", paidOrders: 3, revenueToman: 10 },
      { t: "2026-09-15", paidOrders: 0, revenueToman: 0 },
      { t: "2026-09-16", paidOrders: 5, revenueToman: 20 },
    ];
    expect(paidOrdersBetween(points, "2026-09-14", "2026-09-16")).toBe(8);
    expect(paidOrdersBetween(points, "2026-09-13", "2026-09-14")).toBeNull();
    expect(paidOrdersBetween(points, "2026-10-01", "2026-10-07")).toBeNull();
  });

  it("marks a range that runs to today as still open", () => {
    expect(isOpenRange("2026-09-24", "2026-09-24")).toBe(true);
    expect(isOpenRange("2026-09-23", "2026-09-24")).toBe(false);
  });
});

describe("change formatting", () => {
  it("has no relative change from a zero base and states rate changes in points", () => {
    expect(relativeChange(5, 0)).toBeNull();
    expect(relativeChange(null, 4)).toBeNull();
    expect(relativeChange(15, 10)).toBeCloseTo(50);
    expect(pointChange(0.13, 0.1)).toBeCloseTo(3);
    expect(signedPointsText(2.5)).toContain("واحد درصد");
    expect(ratioText(0.0042)).toBe("۰٫۴۲٪");
    expect(ratioText(null)).toBe("—");
  });
});

describe("trend rows", () => {
  it("aligns the previous period by position and flags the open bucket", () => {
    const built = buildTrendRows(
      "visitors",
      {
        trend: {
          unit: "day",
          points: [
            { t: "2026-09-22", visitors: 100, pageviews: 400 },
            { t: "2026-09-23", visitors: null, pageviews: null },
            { t: "2026-09-24", visitors: 40, pageviews: 90 },
          ],
        },
        previousTrend: {
          unit: "day",
          points: [
            { t: "2026-09-19", visitors: 90, pageviews: 300 },
            { t: "2026-09-20", visitors: 95, pageviews: 310 },
            { t: "2026-09-21", visitors: 98, pageviews: 320 },
          ],
        },
      },
      "2026-09-24",
    )!;
    expect(built.rows.map((row) => [row.t, row.previousT, row.current, row.previous, row.incomplete])).toEqual([
      ["2026-09-22", "2026-09-19", 100, 90, false],
      ["2026-09-23", "2026-09-20", null, 95, false],
      ["2026-09-24", "2026-09-21", 40, 98, true],
    ]);
  });

  it("reads orders and revenue only from the commerce series", () => {
    const built = buildTrendRows(
      "revenue",
      {
        trend: { unit: "day", points: [{ t: "2026-09-22", visitors: 100 }] },
        commerce: { unit: "day", points: [{ t: "2026-09-22", paidOrders: 3, revenueToman: 9_000_000 }] },
      },
      "2026-09-30",
    )!;
    expect(built.rows[0].current).toBe(9_000_000);
    expect(buildTrendRows("paidOrders", { trend: { points: [{ t: "2026-09-22", visitors: 1 }] } }, "2026-09-30")).toBeNull();
  });
});

describe("trend bucket reliability", () => {
  const bucket = (num: number) => ({
    startDate: "2026-09-14",
    endDate: "2026-09-20",
    days: 7,
    incomplete: false,
    steps: funnel([500, 60, 20, 16, 14, 11]),
    purchaseGoal: { num, total: 5000 },
  });
  const orders = Array.from({ length: 7 }, (_, index) => ({
    t: `2026-09-${14 + index}`,
    paidOrders: 6,
    revenueToman: 1,
  }));

  it("reconciles each unfiltered bucket against that bucket's paid orders", () => {
    expect(trendBucketViews([bucket(38)], orders)[0].purchaseReliable).toBe(true);
    expect(trendBucketViews([bucket(1)], orders)[0].purchaseReliable).toBe(false);
  });

  it("inherits the page verdict when a segment filter makes buckets irreconcilable", () => {
    // Two laptop buyers against 42 storefront orders is a segment, not a tracking gap.
    const [view] = trendBucketViews([bucket(2)], orders, true);
    expect(view.purchaseReliable).toBe(true);
    expect(view.analysis?.steps[5].unreliable).toBe(false);
    expect(trendBucketViews([bucket(2)], orders, false)[0].purchaseReliable).toBe(false);
  });
});
