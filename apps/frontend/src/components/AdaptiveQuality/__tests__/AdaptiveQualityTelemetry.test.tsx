import React from "react";
import { act, render } from "@testing-library/react";
import {
  ADAPTIVE_QUALITY_EVENT,
  ADAPTIVE_QUALITY_PROMOTION_EVENT,
} from "@/lib/adaptive-quality/config";
import type {
  AdaptiveQualityChange,
  AdaptiveQualitySnapshot,
} from "@/lib/adaptive-quality";

let mockPathname = "/";
let mockSearchParams = new URLSearchParams();
let mockQuality: AdaptiveQualitySnapshot = {
  enabled: true,
  rendering: "enhanced",
  media: "high",
  motion: "enhanced",
  reducedTransparency: false,
  reason: "default",
  routeGeneration: 0,
};
type MockWebVital = { name: string; value: number; rating?: string };
const mockReportCallbacks: Array<(metric: MockWebVital) => void> = [];
const mockTrackMatomoEvent = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
}));

jest.mock("next/web-vitals", () => ({
  useReportWebVitals: (callback: (metric: MockWebVital) => void) => {
    mockReportCallbacks.push(callback);
  },
}));

jest.mock("@/lib/adaptive-quality", () => ({
  getAdaptiveObservationSummary: () => ({
    observer: "loaf",
    sampleCount: 4,
    issueCount: 1,
    severeCount: 0,
  }),
  getAdaptiveRolloutBucket: () => 0,
  useAdaptiveQuality: () => mockQuality,
}));

jest.mock("@/lib/analytics/matomo", () => ({
  ANALYTICS_CONSENT_EVENT: "analytics-consent-changed",
  getAnalyticsConsent: () => "granted",
  trackMatomoEvent: (event: unknown) => mockTrackMatomoEvent(event),
}));

import AdaptiveQualityTelemetry from "../AdaptiveQualityTelemetry";

describe("AdaptiveQualityTelemetry", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockPathname = "/";
    mockSearchParams = new URLSearchParams();
    mockQuality = {
      enabled: true,
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
      reducedTransparency: false,
      reason: "default",
      routeGeneration: 0,
    };
    mockReportCallbacks.length = 0;
    mockTrackMatomoEvent.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("keeps one Web Vitals callback identity and reports current route/tier context", () => {
    const view = render(<AdaptiveQualityTelemetry />);
    const firstCallback = mockReportCallbacks.at(-1);
    expect(firstCallback).toBeDefined();

    mockPathname = "/cart";
    mockQuality = {
      ...mockQuality,
      rendering: "safe",
      media: "economy",
      motion: "minimal",
      reason: "severe-loaf",
      routeGeneration: 2,
    };
    view.rerender(<AdaptiveQualityTelemetry />);

    expect(new Set(mockReportCallbacks)).toEqual(new Set([firstCallback]));
    act(() => {
      firstCallback?.({
        name: "LCP",
        value: 2_501,
        rating: "needs-improvement",
      });
    });

    expect(mockTrackMatomoEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackMatomoEvent).toHaveBeenCalledWith({
      category: "adaptive_quality",
      action: "web_vital_lcp",
      name: "cart|r:safe|m:economy|o:minimal",
      value: 2501,
    });
  });

  it("emits consent-granted downgrade and recovery telemetry with fixed fields", () => {
    render(<AdaptiveQualityTelemetry />);
    mockTrackMatomoEvent.mockClear();

    const previous = { ...mockQuality };
    const current = {
      ...mockQuality,
      motion: "standard" as const,
      reason: "repeated-loaf" as const,
    };
    const change: AdaptiveQualityChange = {
      previous,
      current,
      reason: "repeated-loaf",
    };
    act(() => {
      window.dispatchEvent(
        new CustomEvent<AdaptiveQualityChange>(ADAPTIVE_QUALITY_EVENT, {
          detail: change,
        }),
      );
    });

    expect(mockTrackMatomoEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "adaptive_quality",
        action: "tier_change",
        name: expect.stringContaining(
          "home|from:r:enhanced|m:high|o:enhanced|to:r:enhanced|m:high|o:standard|reason:repeated-loaf|marker:downgrade",
        ),
      }),
    );

    mockQuality = {
      ...current,
      motion: "enhanced",
      reason: "promotion",
    };
    act(() => {
      window.dispatchEvent(new Event(ADAPTIVE_QUALITY_PROMOTION_EVENT));
    });
    expect(mockTrackMatomoEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "recovery_step",
        name: expect.stringContaining("marker:recovery"),
      }),
    );
  });
});
